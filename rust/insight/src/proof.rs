//! Задача «не робот» для события `engaged` (`contracts/insight.md` §1.2).
//!
//! Тот же протокол, что у ядра (`ProofOfWork.java`, ALTCHA первой версии): сервер выдаёт соль и хэш
//! `SHA-256(соль + n)` для случайного `n ≤ maxnumber`, подписанный HMAC; браузер перебором находит `n` тем же
//! решателем (`web/src/core/proof-solve.ts`). В соль вписаны срок, действие `engaged` и отпечаток адреса, так
//! что выдача ничего не хранит. Ключ подписи — свой (`analytics-proof`): ответ аналитике не откроет создание
//! встречи, и наоборот. Одноразовость проверяет тот, кто принимает ответ (таблица `an_proofs`).

use base64::Engine;
use base64::engine::general_purpose::STANDARD_PAD_INDIFFERENT;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::keys::{equal, hmac};

/// Сколько живёт выданная задача.
pub const TTL_MS: i64 = 5 * 60 * 1000;
/// Цена задачи: человеку — мгновение, скрипту на каждую «личность» — работа.
pub const MAX_NUMBER: u64 = 20_000;
const ACTION: &str = "engaged";

/// Задача, как её получает браузер.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Challenge {
    pub algorithm: &'static str,
    pub challenge: String,
    pub maxnumber: u64,
    pub salt: String,
    pub signature: String,
}

/// Принятый ответ: подпись задачи (по ней одноразовость) и её срок.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Solved {
    pub signature: String,
    pub expires_ms: i64,
}

#[derive(Deserialize)]
struct Answer {
    algorithm: String,
    challenge: String,
    number: u64,
    salt: String,
    signature: String,
}

#[derive(Clone)]
pub struct Proof {
    key: Vec<u8>,
}

impl Proof {
    pub fn new(key: Vec<u8>) -> Self {
        Proof { key }
    }

    /// Новая задача для адреса `address` (ключ адреса, не сам адрес — см. `net::address_key`).
    pub fn issue(&self, address: &str, now_ms: i64) -> Challenge {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).expect("системный источник случайных чисел недоступен");
        let number = getrandom::u64().expect("системный источник случайных чисел недоступен")
            % (MAX_NUMBER + 1);
        self.issue_with(address, now_ms, &nonce, number)
    }

    fn issue_with(&self, address: &str, now_ms: i64, nonce: &[u8], number: u64) -> Challenge {
        let expires = (now_ms + TTL_MS) / 1000;
        let salt = format!(
            "{}?expires={expires}&for={ACTION}&k={}",
            hex::encode(nonce),
            self.fingerprint(address)
        );
        let challenge = hash(&salt, number);
        let signature = self.mac(&challenge);
        Challenge {
            algorithm: "SHA-256",
            challenge,
            maxnumber: MAX_NUMBER,
            salt,
            signature,
        }
    }

    /// Проверить ответ (`engaged.p.proof`): base64 от JSON `{algorithm, challenge, number, salt, signature}`.
    pub fn verify(&self, answer: &str, address: &str, now_ms: i64) -> Option<Solved> {
        if answer.len() > 2048 {
            return None;
        }
        let raw = STANDARD_PAD_INDIFFERENT.decode(answer.trim()).ok()?;
        let answer: Answer = serde_json::from_slice(&raw).ok()?;
        if answer.algorithm != "SHA-256" || answer.number > MAX_NUMBER {
            return None;
        }
        if !equal(&answer.signature, &self.mac(&answer.challenge)) {
            return None;
        }
        if !equal(&answer.challenge, &hash(&answer.salt, answer.number)) {
            return None;
        }
        let params = answer.salt.split_once('?')?.1;
        let param = |name: &str| {
            params
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v)
        };
        let expires_ms = param("expires")?.parse::<i64>().ok()?.checked_mul(1000)?;
        if expires_ms < now_ms
            || param("for")? != ACTION
            || param("k")? != self.fingerprint(address)
        {
            return None;
        }
        Some(Solved {
            signature: answer.signature,
            expires_ms,
        })
    }

    fn mac(&self, value: &str) -> String {
        hex::encode(hmac(&self.key, value.as_bytes()))
    }

    /// Отпечаток адреса в соли: сам адрес задаче видеть незачем.
    fn fingerprint(&self, address: &str) -> String {
        self.mac(&format!("address:{address}"))[..16].to_owned()
    }
}

/// Хэш, который ищет браузер: SHA-256 от соли и десятичного числа подряд, шестнадцатерично.
pub fn hash(salt: &str, number: u64) -> String {
    hex::encode(Sha256::digest(format!("{salt}{number}").as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    const NOW: i64 = 1_793_612_345_678;

    fn proof() -> Proof {
        Proof::new(b"a-proof-key".to_vec())
    }

    /// Решатель браузера: перебор до совпадения хэша.
    fn solve(challenge: &Challenge) -> String {
        let number = (0..=challenge.maxnumber)
            .find(|n| hash(&challenge.salt, *n) == challenge.challenge)
            .unwrap();
        answer(challenge, number)
    }

    fn answer(challenge: &Challenge, number: u64) -> String {
        STANDARD.encode(
            serde_json::json!({
                "algorithm": challenge.algorithm, "challenge": challenge.challenge, "number": number,
                "salt": challenge.salt, "signature": challenge.signature,
            })
            .to_string(),
        )
    }

    /// Образец формата ядра: `ProofOfWork.hash("abc?expires=1&for=create&k=0", 42)` —
    /// `hashlib.sha256(b"abc?expires=1&for=create&k=042").hexdigest()`.
    #[test]
    fn the_hash_is_the_one_the_browser_solver_computes() {
        assert_eq!(
            hash("abc?expires=1&for=create&k=0", 42),
            "1ff234a05c9d1b9c9dd3ac9d67294c3b33a093dbe60325ca2b7d02710bcb830e"
        );
        assert_eq!(
            hash("", 0),
            "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"
        );
    }

    #[test]
    fn a_solved_challenge_is_accepted_for_the_same_address_until_it_expires() {
        let proof = proof();
        let challenge = proof.issue("203.0.113.7", NOW);
        assert_eq!(challenge.algorithm, "SHA-256");
        assert_eq!(challenge.maxnumber, 20_000);
        assert!(challenge.salt.contains("&for=engaged&k="));
        let solved = proof
            .verify(&solve(&challenge), "203.0.113.7", NOW + 1000)
            .unwrap();
        assert_eq!(solved.signature, challenge.signature);
        assert_eq!(solved.expires_ms, (NOW + TTL_MS) / 1000 * 1000);
        // Без дополнения `=` — тоже ответ: так его шлёт `btoa` не всегда, но Java-декодер ядра принимает оба.
        let unpadded = solve(&challenge).trim_end_matches('=').to_owned();
        assert!(proof.verify(&unpadded, "203.0.113.7", NOW).is_some());
        // Чужой адрес, истёкший срок.
        assert_eq!(proof.verify(&solve(&challenge), "203.0.113.8", NOW), None);
        assert_eq!(
            proof.verify(&solve(&challenge), "203.0.113.7", NOW + TTL_MS + 1000),
            None
        );
    }

    #[test]
    fn a_wrong_or_forged_answer_is_refused() {
        let proof = proof();
        let challenge = proof.issue_with("a", NOW, &[7; 12], 1234);
        assert!(proof.verify(&answer(&challenge, 1234), "a", NOW).is_some());
        assert_eq!(proof.verify(&answer(&challenge, 1235), "a", NOW), None);
        // Подпись другим ключом (например, задача ядра для создания встречи).
        let foreign = Proof::new(b"core-proof-key".to_vec()).issue_with("a", NOW, &[7; 12], 1234);
        assert_eq!(proof.verify(&answer(&foreign, 1234), "a", NOW), None);
        // Соль подменена: хэш не сходится; своя соль с чужим действием — подпись не сходится.
        let mut forged = challenge.clone();
        forged.salt = forged.salt.replace("for=engaged", "for=create");
        assert_eq!(proof.verify(&answer(&forged, 1234), "a", NOW), None);
        assert_eq!(proof.verify("не base64", "a", NOW), None);
        assert_eq!(proof.verify(&STANDARD.encode("{}"), "a", NOW), None);
        assert_eq!(proof.verify(&"A".repeat(4096), "a", NOW), None);
    }
}
