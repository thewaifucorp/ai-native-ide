//! Transactional benchmark domain used to prove the IDE's end-to-end journey.
//!
//! A listing has one visible position. A bid must be strictly greater than the
//! current winning amount. Equal bids are deterministically rejected, so the
//! outcome never depends on scheduler timing. Bidder identities are retained
//! for audit but never appear in the public leaderboard response.

use axum::{extract::State, http::StatusCode, response::Html, routing::get, Json, Router};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBid {
    pub listing_id: String,
    pub bidder_id: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BidOutcome {
    pub accepted: bool,
    pub amount_cents: i64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicListing {
    pub listing_id: String,
    pub title: String,
    pub amount_cents: i64,
}

#[derive(Debug, Error)]
pub enum BenchmarkError {
    #[error("bid amount must be positive")]
    NonPositiveBid,
    #[error("listing id and bidder id are required")]
    MissingIdentity,
    #[error("benchmark store mutex was poisoned")]
    PoisonedStore,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

/// A serializable SQLite boundary. Every bid is evaluated and recorded in one
/// immediate transaction; callers can safely submit from concurrent threads.
pub struct BenchmarkStore {
    connection: Mutex<Connection>,
}

impl BenchmarkStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, BenchmarkError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self, BenchmarkError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, BenchmarkError> {
        connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS listings (
                listing_id TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
                winning_bidder_id TEXT
            );
            CREATE TABLE IF NOT EXISTS bid_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                listing_id TEXT NOT NULL,
                bidder_id TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                accepted INTEGER NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn create_listing(&self, listing_id: &str, title: &str) -> Result<(), BenchmarkError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| BenchmarkError::PoisonedStore)?;
        connection.execute(
            "INSERT INTO listings (listing_id, title, amount_cents) VALUES (?1, ?2, 0)",
            params![listing_id, title],
        )?;
        Ok(())
    }

    /// Seeds the benchmark without treating a restart as an exceptional mutation.
    /// It never changes an existing listing or its current leading bid.
    pub fn ensure_listing(&self, listing_id: &str, title: &str) -> Result<(), BenchmarkError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| BenchmarkError::PoisonedStore)?;
        connection.execute(
            "INSERT OR IGNORE INTO listings (listing_id, title, amount_cents) VALUES (?1, ?2, 0)",
            params![listing_id, title],
        )?;
        Ok(())
    }

    pub fn place_bid(&self, bid: NewBid) -> Result<BidOutcome, BenchmarkError> {
        if bid.amount_cents <= 0 {
            return Err(BenchmarkError::NonPositiveBid);
        }
        if bid.listing_id.trim().is_empty() || bid.bidder_id.trim().is_empty() {
            return Err(BenchmarkError::MissingIdentity);
        }

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| BenchmarkError::PoisonedStore)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT amount_cents FROM listings WHERE listing_id = ?1",
                params![bid.listing_id],
                |row| row.get(0),
            )
            .optional()?;

        let outcome = match current {
            None => BidOutcome {
                accepted: false,
                amount_cents: bid.amount_cents,
                reason: "listing_not_found".to_string(),
            },
            Some(current_amount) if bid.amount_cents <= current_amount => BidOutcome {
                accepted: false,
                amount_cents: current_amount,
                reason: "must_strictly_exceed_current_bid".to_string(),
            },
            Some(_) => {
                transaction.execute(
                    "UPDATE listings SET amount_cents = ?1, winning_bidder_id = ?2 WHERE listing_id = ?3",
                    params![bid.amount_cents, bid.bidder_id, bid.listing_id],
                )?;
                BidOutcome {
                    accepted: true,
                    amount_cents: bid.amount_cents,
                    reason: "leading_bid".to_string(),
                }
            }
        };

        transaction.execute(
            "INSERT INTO bid_audit (listing_id, bidder_id, amount_cents, accepted, reason) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![bid.listing_id, bid.bidder_id, bid.amount_cents, outcome.accepted, outcome.reason],
        )?;
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn public_leaderboard(&self) -> Result<Vec<PublicListing>, BenchmarkError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| BenchmarkError::PoisonedStore)?;
        let mut statement = connection.prepare(
            "SELECT listing_id, title, amount_cents FROM listings ORDER BY amount_cents DESC, listing_id ASC",
        )?;
        let listings = statement
            .query_map([], |row| {
                Ok(PublicListing {
                    listing_id: row.get(0)?,
                    title: row.get(1)?,
                    amount_cents: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(BenchmarkError::from);
        listings
    }
}

#[derive(Clone)]
pub struct BenchmarkHttpState(pub Arc<BenchmarkStore>);

pub fn router(store: Arc<BenchmarkStore>) -> Router {
    Router::new()
        .route("/", get(benchmark_page))
        .route("/health", get(|| async { StatusCode::NO_CONTENT }))
        .route("/api/leaderboard", get(public_leaderboard))
        .route("/api/bids", axum::routing::post(place_bid))
        .with_state(BenchmarkHttpState(store))
}

async fn benchmark_page() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leilão de posições</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;background:#101416;color:#edf3f3}article,form{border:1px solid #334047;border-radius:12px;padding:20px;margin:14px 0;background:#182025}label{display:grid;gap:6px;margin:10px 0}input,button{font:inherit;padding:10px;border-radius:7px;border:1px solid #50606a}button{background:#98efc4;color:#102019;font-weight:700;cursor:pointer}small{color:#aebcc0}</style></head>
<body><main><small>PREVIEW LOCAL · benchmark transacional</small><h1>Leilão de posições</h1><p>Quem oferece mais fica em primeiro. Empates não vencem.</p><section id="board">Carregando posições…</section><form id="bid"><h2>Fazer um lance</h2><label>Posição<input name="listing" value="listing:home" required></label><label>Identificador do comprador<input name="bidder" placeholder="ex.: loja-aurora" required></label><label>Valor em centavos<input name="amount" type="number" min="1" required></label><button>Enviar lance</button><p id="result"></p></form></main><script>const b=document.querySelector('#board'),f=document.querySelector('#bid'),r=document.querySelector('#result');async function load(){const x=await fetch('/api/leaderboard');const rows=await x.json();b.innerHTML=rows.map(x=>`<article><strong>${x.title}</strong><br>R$ ${(x.amountCents/100).toFixed(2)}</article>`).join('')}f.onsubmit=async e=>{e.preventDefault();const d=new FormData(f);const q=await fetch('/api/bids',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({listingId:d.get('listing'),bidderId:d.get('bidder'),amountCents:Number(d.get('amount'))})});const o=await q.json();r.textContent=o.accepted?'Lance líder registrado.':`Não aceito: ${o.reason}`;await load()};load()</script></body></html>"#,
    )
}

async fn public_leaderboard(
    State(BenchmarkHttpState(store)): State<BenchmarkHttpState>,
) -> Result<Json<Vec<PublicListing>>, (StatusCode, String)> {
    store.public_leaderboard().map(Json).map_err(internal_error)
}

async fn place_bid(
    State(BenchmarkHttpState(store)): State<BenchmarkHttpState>,
    Json(bid): Json<NewBid>,
) -> Result<(StatusCode, Json<BidOutcome>), (StatusCode, String)> {
    let outcome = store.place_bid(bid).map_err(|error| match error {
        BenchmarkError::NonPositiveBid | BenchmarkError::MissingIdentity => {
            (StatusCode::BAD_REQUEST, error.to_string())
        }
        other => internal_error(other),
    })?;
    Ok((StatusCode::OK, Json(outcome)))
}

fn internal_error(error: BenchmarkError) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    #[test]
    fn keeps_bidder_private_and_rejects_ties() {
        let store = BenchmarkStore::in_memory().expect("store");
        store
            .create_listing("listing:home", "Home page")
            .expect("listing");
        assert!(
            store
                .place_bid(NewBid {
                    listing_id: "listing:home".into(),
                    bidder_id: "buyer:one".into(),
                    amount_cents: 500
                })
                .expect("bid")
                .accepted
        );
        let tie = store
            .place_bid(NewBid {
                listing_id: "listing:home".into(),
                bidder_id: "buyer:two".into(),
                amount_cents: 500,
            })
            .expect("tie");
        assert!(!tie.accepted);
        assert_eq!(tie.reason, "must_strictly_exceed_current_bid");
        let public = store.public_leaderboard().expect("public listing");
        assert_eq!(
            public,
            vec![PublicListing {
                listing_id: "listing:home".into(),
                title: "Home page".into(),
                amount_cents: 500
            }]
        );
    }

    #[test]
    fn concurrent_bids_converge_to_the_unique_highest_bid() {
        let store = Arc::new(BenchmarkStore::in_memory().expect("store"));
        store
            .create_listing("listing:home", "Home page")
            .expect("listing");
        let gate = Arc::new(Barrier::new(8));
        let amounts = [100, 200, 300, 400, 500, 600, 700, 800];
        let mut workers = Vec::with_capacity(amounts.len());
        for amount_cents in amounts {
            let store = store.clone();
            let gate = gate.clone();
            workers.push(thread::spawn(move || {
                gate.wait();
                store.place_bid(NewBid {
                    listing_id: "listing:home".into(),
                    bidder_id: format!("buyer:{amount_cents}"),
                    amount_cents,
                })
            }));
        }
        for worker in workers {
            worker.join().expect("worker panicked").expect("bid failed");
        }
        assert_eq!(
            store.public_leaderboard().expect("leaderboard")[0].amount_cents,
            800
        );
    }
}
