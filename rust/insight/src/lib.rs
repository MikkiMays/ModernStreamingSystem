//! Служба аналитики Cord `insight` (R239): люди, а не профили.
//!
//! Проект — `docs/architecture/analytics-v2.md`, контракт — `contracts/insight.md`, формы отчётов —
//! `contracts/insight-reports.md`.
#![cfg_attr(test, allow(clippy::unwrap_used))]

pub mod classify;
pub mod config;
pub mod days;
pub mod db;
pub mod engine;
pub mod errors;
pub mod event;
pub mod fact;
pub mod http;
pub mod keys;
pub mod metrics;
pub mod net;
pub mod proof;
pub mod reports;
pub mod retention;
pub mod ua;
