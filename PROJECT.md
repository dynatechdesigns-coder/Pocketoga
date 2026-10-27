# PocketOga
It finds and protects the money your shop is losing.

## What it is
A voice-first AI assistant on WhatsApp and the web for Nigerian small traders.
Traders speak in English or Pidgin. PocketOga shows what it heard, runs strict
checks, and saves only after the trader taps confirm.

## Core features
1. Voice recording of sales, payments, debts and stock (Pidgin and Nigerian money talk like 15k, remain 3k). Asks when unsure.
2. Hash-chained ledger: append-only, never edited or deleted. Corrections are new entries. Tampering is detected.
3. Debt recovery: promise tracking, chase ranking, reminder drafts in 3 tones sent from the trader's own WhatsApp.
4. Alert Guard: flags warning signs in payment screenshots, receipts and SMS alerts. Never says verified; always says confirm in your bank app.
5. Money Leak Report: one number for money lost or at risk this month.
6. Notebook photo import.

## Rules
- AI only proposes. Plain code does all math and checks. The trader confirms before anything saves.
- Never store full account numbers (last 4 digits only).
- Use only fake test data while coding. No real trader data.
- Never commit .env or API keys.

## Stack
Meta Muse Spark (voice and images), secure database ledger, WhatsApp Cloud API, web app (PWA).
