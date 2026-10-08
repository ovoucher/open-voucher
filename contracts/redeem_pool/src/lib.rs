//! Redemption pool for one Open Voucher asset (one instance per asset, e.g. `OVFOOD`).
//!
//! The agency funds the pool with USDC. A merchant that registered with
//! `merchant_registry` for the pool's category calls `redeem(amount)`: the pool,
//! which is the SAC admin of the voucher asset, claws the vouchers back from the
//! merchant (burning them) and pays USDC 1:1. If the float cannot cover the claim,
//! or earlier claims are still waiting, the claim is queued FIFO and a `shortfall`
//! event makes the gap public. `settle_queue` pays queued claims strictly in order.
//!
//! Deliberately absent: no `mint`, no generic `clawback`, no admin transfer of
//! vouchers. Expiry clawback of recipient balances is a classic `Clawback` operation
//! signed by the agency ops key, outside this contract.
//!
//! Invariants (asserted by the property test):
//! * `clawed == paid + queued`
//! * `usdc.balance(pool) == funded - paid - withdrawn` (absent direct USDC transfers)
//! * no total is ever negative; claims are paid in id order.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env,
};

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    InvalidAmount = 3,
    MerchantNotActive = 4,
    InsufficientVouchers = 5,
    RedemptionClosed = 6,
    WindowOpen = 7,
    QueueNotEmpty = 8,
    InsufficientFloat = 9,
    DeadlineNotLater = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub registry: Address,
    /// SAC of the voucher asset; this pool must be its admin.
    pub voucher: Address,
    /// SAC (or any SEP-41 token) used for the float.
    pub usdc: Address,
    /// Category bit checked against `merchant_registry.is_active`.
    pub category: u32,
    pub redeem_deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Totals {
    pub funded: i128,
    pub paid: i128,
    pub queued: i128,
    pub clawed: i128,
    pub withdrawn: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claim {
    pub merchant: Address,
    pub amount: i128,
    pub queued_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RedeemOutcome {
    Paid(i128),
    Queued(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Coverage {
    /// USDC currently held by the pool.
    pub float: i128,
    pub queued: i128,
    pub paid: i128,
    pub clawed: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Totals,
    Head,
    Tail,
    Claim(u32),
}

/// The only registry function the pool needs.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn is_active(env: Env, merchant: Address, category: u32) -> bool;
}

// ---------------------------------------------------------------- events

#[contractevent(topics = ["fund"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Funded {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["redeem"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Redeemed {
    #[topic]
    pub merchant: Address,
    pub amount: i128,
    pub outcome: RedeemOutcome,
}

#[contractevent(topics = ["shortfall"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Shortfall {
    #[topic]
    pub merchant: Address,
    pub amount: i128,
    /// `amount - available float` at the time of the claim (0 when the claim was
    /// queued only because earlier claims are waiting).
    pub gap: i128,
}

#[contractevent(topics = ["settle"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub claim_id: u32,
    pub merchant: Address,
    pub amount: i128,
}

#[contractevent(topics = ["withdraw"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

// ---------------------------------------------------------------- helpers

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialised)
}

fn totals(env: &Env) -> Totals {
    env.storage()
        .instance()
        .get(&DataKey::Totals)
        .unwrap_or_default()
}

fn put_totals(env: &Env, t: &Totals) {
    env.storage().instance().set(&DataKey::Totals, t);
}

fn head(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Head).unwrap_or(0)
}

fn tail(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Tail).unwrap_or(0)
}

fn float(env: &Env, cfg: &Config) -> i128 {
    token::TokenClient::new(env, &cfg.usdc).balance(&env.current_contract_address())
}

#[contract]
pub struct RedeemPool;

#[contractimpl]
impl RedeemPool {
    /// One-time initialisation. After this, the deployer must call the voucher SAC's
    /// `set_admin(<this pool>)` so that `redeem` can claw back vouchers.
    pub fn init(
        env: Env,
        admin: Address,
        registry: Address,
        voucher: Address,
        usdc: Address,
        category: u32,
        redeem_deadline: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialised);
        }
        let cfg = Config {
            admin,
            registry,
            voucher,
            usdc,
            category,
            redeem_deadline,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        put_totals(&env, &Totals::default());
        env.storage().instance().set(&DataKey::Head, &0u32);
        env.storage().instance().set(&DataKey::Tail, &0u32);
        bump(&env);
        Ok(())
    }

    /// Add USDC float. `from` auth.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        let cfg = config(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        let mut t = totals(&env);
        t.funded += amount;
        put_totals(&env, &t);
        bump(&env);
        Funded { from, amount }.publish(&env);
        Ok(())
    }

    /// Burn `amount` vouchers held by `merchant` and pay USDC 1:1, or queue the claim.
    pub fn redeem(env: Env, merchant: Address, amount: i128) -> Result<RedeemOutcome, Error> {
        let cfg = config(&env)?;
        merchant.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if now > cfg.redeem_deadline {
            return Err(Error::RedemptionClosed);
        }
        if !RegistryClient::new(&env, &cfg.registry).is_active(&merchant, &cfg.category) {
            return Err(Error::MerchantNotActive);
        }
        let voucher = token::StellarAssetClient::new(&env, &cfg.voucher);
        let voucher_balance = token::TokenClient::new(&env, &cfg.voucher).balance(&merchant);
        if voucher_balance < amount {
            return Err(Error::InsufficientVouchers);
        }

        voucher.clawback(&merchant, &amount);
        let mut t = totals(&env);
        t.clawed += amount;

        let (h, tl) = (head(&env), tail(&env));
        let available = float(&env, &cfg);
        let outcome = if h == tl && available >= amount {
            token::TokenClient::new(&env, &cfg.usdc).transfer(
                &env.current_contract_address(),
                &merchant,
                &amount,
            );
            t.paid += amount;
            RedeemOutcome::Paid(amount)
        } else {
            let claim = Claim {
                merchant: merchant.clone(),
                amount,
                queued_at: now,
            };
            let k = DataKey::Claim(tl);
            env.storage().persistent().set(&k, &claim);
            env.storage()
                .persistent()
                .extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND_TO);
            env.storage().instance().set(&DataKey::Tail, &(tl + 1));
            t.queued += amount;
            let gap = if amount > available {
                amount - available
            } else {
                0
            };
            Shortfall {
                merchant: merchant.clone(),
                amount,
                gap,
            }
            .publish(&env);
            RedeemOutcome::Queued(tl)
        };
        put_totals(&env, &t);
        bump(&env);
        Redeemed {
            merchant,
            amount,
            outcome: outcome.clone(),
        }
        .publish(&env);
        Ok(outcome)
    }

    /// Pay up to `max` queued claims from the head, strictly FIFO. Stops at the first
    /// claim the float cannot cover. Anyone may call. Returns the number paid.
    pub fn settle_queue(env: Env, max: u32) -> Result<u32, Error> {
        let cfg = config(&env)?;
        let usdc = token::TokenClient::new(&env, &cfg.usdc);
        let pool = env.current_contract_address();
        let mut h = head(&env);
        let tl = tail(&env);
        let mut t = totals(&env);
        let mut available = usdc.balance(&pool);
        let mut n = 0u32;
        while h < tl && n < max {
            let k = DataKey::Claim(h);
            let claim: Claim = match env.storage().persistent().get(&k) {
                Some(c) => c,
                None => break,
            };
            if available < claim.amount {
                break;
            }
            usdc.transfer(&pool, &claim.merchant, &claim.amount);
            available -= claim.amount;
            t.paid += claim.amount;
            t.queued -= claim.amount;
            env.storage().persistent().remove(&k);
            Settled {
                claim_id: h,
                merchant: claim.merchant,
                amount: claim.amount,
            }
            .publish(&env);
            h += 1;
            n += 1;
        }
        env.storage().instance().set(&DataKey::Head, &h);
        put_totals(&env, &t);
        bump(&env);
        Ok(n)
    }

    /// Move the redemption deadline later. Admin auth.
    pub fn extend_deadline(env: Env, new_deadline: u64) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.admin.require_auth();
        if new_deadline <= cfg.redeem_deadline {
            return Err(Error::DeadlineNotLater);
        }
        cfg.redeem_deadline = new_deadline;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump(&env);
        Ok(())
    }

    /// Return unspent float to the agency. Admin auth; only after the redemption
    /// deadline and with an empty queue.
    pub fn withdraw_surplus(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let cfg = config(&env)?;
        cfg.admin.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env.ledger().timestamp() <= cfg.redeem_deadline {
            return Err(Error::WindowOpen);
        }
        if head(&env) != tail(&env) {
            return Err(Error::QueueNotEmpty);
        }
        if float(&env, &cfg) < amount {
            return Err(Error::InsufficientFloat);
        }
        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        let mut t = totals(&env);
        t.withdrawn += amount;
        put_totals(&env, &t);
        bump(&env);
        Withdrawn { to, amount }.publish(&env);
        Ok(())
    }

    // ------------------------------------------------------------ views

    pub fn coverage(env: Env) -> Result<Coverage, Error> {
        let cfg = config(&env)?;
        let t = totals(&env);
        Ok(Coverage {
            float: float(&env, &cfg),
            queued: t.queued,
            paid: t.paid,
            clawed: t.clawed,
        })
    }

    pub fn totals(env: Env) -> Totals {
        totals(&env)
    }

    pub fn claim(env: Env, id: u32) -> Option<Claim> {
        env.storage().persistent().get(&DataKey::Claim(id))
    }

    /// `(head, tail)`: claims `head..tail` are waiting.
    pub fn queue(env: Env) -> (u32, u32) {
        (head(&env), tail(&env))
    }

    pub fn config(env: Env) -> Result<Config, Error> {
        config(&env)
    }
}

mod test;
