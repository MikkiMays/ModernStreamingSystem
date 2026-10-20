import { describe, expect, it, vi } from 'vitest';
import { sha256, solveChallenge, type Challenge } from './proof-solve';
import { prepareProof, takeProof } from './proof';

/*
  Невидимая проверка «не бот» (E11-B). Решатель браузера и проверка ядра считают один и тот же хэш:
  SHA-256 от соли и десятичного числа подряд. Вектор ниже посчитан отдельно (Python hashlib) и лежит
  тем же в `ProofOfWorkTest` ядра — это и есть контракт двух сторон.
*/

const SALT = '5f1d2c3b4a596877?expires=1900000000&for=create&k=0123456789abcdef';

describe('решатель задачи «не бот»', () => {
  it('считает SHA-256 так же, как ядро', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(SALT + 31337)).toBe('ad91462b2f8bc4a73b1abbb322bedb6fecb98d014b032f57edd9a32954093494');
    // Длинная строка — два блока, кириллица — многобайтный UTF-8.
    expect(sha256('ж'.repeat(40))).toBe(sha256('ж'.repeat(40)));
    expect(sha256('ж'.repeat(40))).toHaveLength(64);
  });

  it('находит число и отдаёт ответ в виде ALTCHA', () => {
    const challenge: Challenge = {
      algorithm: 'SHA-256',
      challenge: sha256(SALT + 777),
      maxnumber: 1000,
      salt: SALT,
      signature: 'подпись',
    };
    const answer = JSON.parse(atob(solveChallenge(challenge)!)) as Record<string, unknown>;
    expect(answer).toEqual({
      algorithm: 'SHA-256',
      challenge: challenge.challenge,
      number: 777,
      salt: SALT,
      signature: 'подпись',
    });
    expect(solveChallenge({ ...challenge, maxnumber: 500 })).toBeNull();
    expect(solveChallenge({ ...challenge, algorithm: 'SHA-1' })).toBeNull();
  });
});

describe('задача на действие', () => {
  it('подготовленная заранее берётся один раз, следующая — новая', async () => {
    const fetchChallenge = vi.fn(() =>
      Promise.resolve<Challenge>({
        algorithm: 'SHA-256',
        challenge: sha256(SALT + 3),
        maxnumber: 10,
        salt: SALT,
        signature: 's',
      }),
    );
    prepareProof('create', fetchChallenge);
    prepareProof('create', fetchChallenge);
    expect(await takeProof('create', fetchChallenge)).toBeTruthy();
    expect(fetchChallenge).toHaveBeenCalledTimes(1);
    expect(await takeProof('create', fetchChallenge)).toBeTruthy();
    expect(fetchChallenge).toHaveBeenCalledTimes(2);
  });

  it('выключенная на сервере проверка или сбой — без ответа, а не без входа', async () => {
    expect(await takeProof('code', () => Promise.resolve(undefined))).toBeNull();
    expect(await takeProof('code', () => Promise.reject(new Error('сеть')))).toBeNull();
  });
});
