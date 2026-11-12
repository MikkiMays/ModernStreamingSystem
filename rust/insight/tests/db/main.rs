//! Тесты службы на настоящем PostgreSQL: личность, классы, факты, отчёты.
//!
//! Сервер — одноразовый, из `DATABASE_URL`; каждый тест заводит себе базу.
#![allow(clippy::unwrap_used)]

mod common;
mod facts;
mod http;
mod humans;
mod identity;
mod reports;
mod upkeep;
