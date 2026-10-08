//! Merchant registry for Open Voucher.
//!
//! One record per merchant G-address, bound to exactly one licence hash:
//!
//! ```text
//! licence_hash = sha256(upper(issuing_authority) || ":" || normalised_licence_no)
//! normalised_licence_no = licence number with spaces and dashes removed, uppercased
//! ```
//!
//! State machine:
//!
//! ```text
//! ∅ --apply--> Pending --approve--> Active <--suspend/reinstate--> Suspended
//! ∅ --enrol (agency, legacy vendor)--> Active
//! Pending --reject--> ∅            (licence index freed)
//! {Pending, Active, Suspended} --revoke--> Revoked   (terminal, licence stays bound)
//! ```
//!
//! Licence expiry does not change the state; it makes `is_active` false until a verifier
//! records a renewal. The SEP-8 approval server and `redeem_pool` both read `is_active`.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
};

/// Category bit for food vouchers (`OVFOOD`).
pub const FOOD: u32 = 1;
/// Category bit for farm-input vouchers (`OVAGRI`).
pub const AGRI: u32 = 2;
/// Categories known at initialisation. The admin may add bits with `set_known_mask`.
pub const KNOWN_MASK: u32 = FOOD | AGRI;

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    NotVerifier = 3,
    UnknownCategory = 4,
    LicenceInUse = 5,
    AlreadyExists = 6,
    NotFound = 7,
    BadState = 8,
    LicenceExpired = 9,
    MaskShrink = 10,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MerchantStatus {
    Pending,
    Active,
    Suspended,
    Revoked,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Merchant {
    pub licence_hash: BytesN<32>,
    pub categories: u32,
    pub status: MerchantStatus,
    pub self_onboarded: bool,
    pub applied_at: u64,
    pub activated_at: u64,
    pub licence_expires: u64,
    /// Last suspension / revocation reason code (0 = none).
    pub reason: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    KnownMask,
    Count,
    Verifier(Address),
    Merchant(Address),
    Licence(BytesN<32>),
}

// ---------------------------------------------------------------- events

#[contractevent(topics = ["applied"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Applied {
    #[topic]
    pub merchant: Address,
    pub categories: u32,
}

#[contractevent(topics = ["approved"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approved {
    #[topic]
    pub merchant: Address,
    #[topic]
    pub verifier: Address,
    pub licence_expires: u64,
}

#[contractevent(topics = ["enrolled"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Enrolled {
    #[topic]
    pub merchant: Address,
    pub categories: u32,
}

#[contractevent(topics = ["rejected"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rejected {
    #[topic]
    pub merchant: Address,
    pub reason: u32,
}

#[contractevent(topics = ["suspended"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Suspended {
    #[topic]
    pub merchant: Address,
    pub reason: u32,
}

#[contractevent(topics = ["reinstated"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reinstated {
    #[topic]
    pub merchant: Address,
    pub at: u64,
}

#[contractevent(topics = ["revoked"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Revoked {
    #[topic]
    pub merchant: Address,
    pub reason: u32,
}

// ---------------------------------------------------------------- helpers

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialised)
}

fn require_admin(env: &Env) -> Result<Address, Error> {
    let a = admin(env)?;
    a.require_auth();
    Ok(a)
}

fn known_mask(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::KnownMask)
        .unwrap_or(KNOWN_MASK)
}

fn check_categories(env: &Env, categories: u32) -> Result<(), Error> {
    if categories == 0 || categories & !known_mask(env) != 0 {
        return Err(Error::UnknownCategory);
    }
    Ok(())
}

fn load(env: &Env, merchant: &Address) -> Result<Merchant, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Merchant(merchant.clone()))
        .ok_or(Error::NotFound)
}

fn store(env: &Env, merchant: &Address, m: &Merchant) {
    let k = DataKey::Merchant(merchant.clone());
    env.storage().persistent().set(&k, m);
    env.storage()
        .persistent()
        .extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND_TO);
    bump_instance(env);
}

fn bind_licence(env: &Env, licence_hash: &BytesN<32>, merchant: &Address) {
    let k = DataKey::Licence(licence_hash.clone());
    env.storage().persistent().set(&k, merchant);
    env.storage()
        .persistent()
        .extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn require_verifier(env: &Env, verifier: &Address) -> Result<(), Error> {
    verifier.require_auth();
    let enabled: bool = env
        .storage()
        .persistent()
        .get(&DataKey::Verifier(verifier.clone()))
        .unwrap_or(false);
    if !enabled {
        return Err(Error::NotVerifier);
    }
    Ok(())
}

fn count(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Count).unwrap_or(0)
}

fn set_count(env: &Env, n: u32) {
    env.storage().instance().set(&DataKey::Count, &n);
}

/// A licence may be bound by `merchant` if it is unbound, or bound to `merchant`
/// itself and that record is not revoked (revocation retires the licence for good).
fn check_licence_free(env: &Env, licence_hash: &BytesN<32>, merchant: &Address) -> Result<(), Error> {
    let bound: Option<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Licence(licence_hash.clone()));
    match bound {
        None => Ok(()),
        Some(owner) if owner != *merchant => Err(Error::LicenceInUse),
        Some(_) => match load(env, merchant) {
            Ok(m) if m.status == MerchantStatus::Revoked => Err(Error::LicenceInUse),
            _ => Ok(()),
        },
    }
}

#[contract]
pub struct MerchantRegistry;

#[contractimpl]
impl MerchantRegistry {
    /// One-time initialisation with the agency admin.
    pub fn init(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialised);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::KnownMask, &KNOWN_MASK);
        set_count(&env, 0);
        bump_instance(&env);
        Ok(())
    }

    /// Enable or disable a verifier key (the onboarding service's key). Admin auth.
    pub fn set_verifier(env: Env, verifier: Address, enabled: bool) -> Result<(), Error> {
        require_admin(&env)?;
        let k = DataKey::Verifier(verifier);
        env.storage().persistent().set(&k, &enabled);
        env.storage()
            .persistent()
            .extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND_TO);
        bump_instance(&env);
        Ok(())
    }

    /// Add category bits. Admin auth. Removing a known bit is refused (`MaskShrink`),
    /// because existing merchant records would silently lose meaning.
    pub fn set_known_mask(env: Env, mask: u32) -> Result<(), Error> {
        require_admin(&env)?;
        let current = known_mask(&env);
        if mask & current != current {
            return Err(Error::MaskShrink);
        }
        env.storage().instance().set(&DataKey::KnownMask, &mask);
        bump_instance(&env);
        Ok(())
    }

    /// Direct agency enrolment of an existing contracted vendor. Admin auth.
    /// Goes straight to `Active` with `self_onboarded = false`.
    pub fn enrol(
        env: Env,
        merchant: Address,
        licence_hash: BytesN<32>,
        categories: u32,
        licence_expires: u64,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        check_categories(&env, categories)?;
        let now = env.ledger().timestamp();
        if licence_expires <= now {
            return Err(Error::LicenceExpired);
        }
        check_licence_free(&env, &licence_hash, &merchant)?;
        let existing = env
            .storage()
            .persistent()
            .get::<_, Merchant>(&DataKey::Merchant(merchant.clone()));
        let is_new = match existing {
            None => true,
            Some(m) if m.status == MerchantStatus::Revoked => false,
            Some(_) => return Err(Error::AlreadyExists),
        };
        let m = Merchant {
            licence_hash: licence_hash.clone(),
            categories,
            status: MerchantStatus::Active,
            self_onboarded: false,
            applied_at: now,
            activated_at: now,
            licence_expires,
            reason: 0,
        };
        bind_licence(&env, &licence_hash, &merchant);
        store(&env, &merchant, &m);
        if is_new {
            set_count(&env, count(&env) + 1);
        }
        Enrolled {
            merchant,
            categories,
        }
        .publish(&env);
        Ok(())
    }

    /// Merchant self-onboarding. Merchant auth. Creates a `Pending` record.
    pub fn apply(
        env: Env,
        merchant: Address,
        licence_hash: BytesN<32>,
        categories: u32,
    ) -> Result<(), Error> {
        admin(&env)?;
        merchant.require_auth();
        check_categories(&env, categories)?;
        check_licence_free(&env, &licence_hash, &merchant)?;
        let existing = env
            .storage()
            .persistent()
            .get::<_, Merchant>(&DataKey::Merchant(merchant.clone()));
        let is_new = match existing {
            None => true,
            Some(m) if m.status == MerchantStatus::Revoked => false,
            Some(_) => return Err(Error::AlreadyExists),
        };
        let now = env.ledger().timestamp();
        let m = Merchant {
            licence_hash: licence_hash.clone(),
            categories,
            status: MerchantStatus::Pending,
            self_onboarded: true,
            applied_at: now,
            activated_at: 0,
            licence_expires: 0,
            reason: 0,
        };
        bind_licence(&env, &licence_hash, &merchant);
        store(&env, &merchant, &m);
        if is_new {
            set_count(&env, count(&env) + 1);
        }
        Applied {
            merchant,
            categories,
        }
        .publish(&env);
        Ok(())
    }

    /// `Pending -> Active`. Verifier auth; the verifier must be enabled.
    pub fn approve(
        env: Env,
        verifier: Address,
        merchant: Address,
        licence_expires: u64,
    ) -> Result<(), Error> {
        require_verifier(&env, &verifier)?;
        let mut m = load(&env, &merchant)?;
        if m.status != MerchantStatus::Pending {
            return Err(Error::BadState);
        }
        let now = env.ledger().timestamp();
        if licence_expires <= now {
            return Err(Error::LicenceExpired);
        }
        m.status = MerchantStatus::Active;
        m.activated_at = now;
        m.licence_expires = licence_expires;
        store(&env, &merchant, &m);
        Approved {
            merchant,
            verifier,
            licence_expires,
        }
        .publish(&env);
        Ok(())
    }

    /// `Pending -> ∅`. Verifier auth. The licence index is freed.
    pub fn reject(env: Env, verifier: Address, merchant: Address, reason: u32) -> Result<(), Error> {
        require_verifier(&env, &verifier)?;
        let m = load(&env, &merchant)?;
        if m.status != MerchantStatus::Pending {
            return Err(Error::BadState);
        }
        env.storage()
            .persistent()
            .remove(&DataKey::Merchant(merchant.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Licence(m.licence_hash));
        set_count(&env, count(&env).saturating_sub(1));
        bump_instance(&env);
        Rejected { merchant, reason }.publish(&env);
        Ok(())
    }

    /// `Active -> Suspended`. Admin auth.
    pub fn suspend(env: Env, merchant: Address, reason: u32) -> Result<(), Error> {
        require_admin(&env)?;
        let mut m = load(&env, &merchant)?;
        if m.status != MerchantStatus::Active {
            return Err(Error::BadState);
        }
        m.status = MerchantStatus::Suspended;
        m.reason = reason;
        store(&env, &merchant, &m);
        Suspended { merchant, reason }.publish(&env);
        Ok(())
    }

    /// `Suspended -> Active`. Admin auth.
    pub fn reinstate(env: Env, merchant: Address) -> Result<(), Error> {
        require_admin(&env)?;
        let mut m = load(&env, &merchant)?;
        if m.status != MerchantStatus::Suspended {
            return Err(Error::BadState);
        }
        m.status = MerchantStatus::Active;
        m.reason = 0;
        store(&env, &merchant, &m);
        Reinstated {
            merchant,
            at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// `{Pending, Active, Suspended} -> Revoked`. Admin auth. Terminal: the licence
    /// index stays bound so the licence cannot be reused from another address.
    pub fn revoke(env: Env, merchant: Address, reason: u32) -> Result<(), Error> {
        require_admin(&env)?;
        let mut m = load(&env, &merchant)?;
        if m.status == MerchantStatus::Revoked {
            return Err(Error::BadState);
        }
        m.status = MerchantStatus::Revoked;
        m.reason = reason;
        store(&env, &merchant, &m);
        Revoked { merchant, reason }.publish(&env);
        Ok(())
    }

    /// Replace a merchant's category mask. Admin auth.
    pub fn set_categories(env: Env, merchant: Address, categories: u32) -> Result<(), Error> {
        require_admin(&env)?;
        check_categories(&env, categories)?;
        let mut m = load(&env, &merchant)?;
        if m.status == MerchantStatus::Revoked {
            return Err(Error::BadState);
        }
        m.categories = categories;
        store(&env, &merchant, &m);
        Ok(())
    }

    /// Record a licence renewal. Verifier auth. Only for `Active` or `Suspended`
    /// records, and the new expiry must be in the future.
    pub fn renew_licence(
        env: Env,
        verifier: Address,
        merchant: Address,
        licence_expires: u64,
    ) -> Result<(), Error> {
        require_verifier(&env, &verifier)?;
        let mut m = load(&env, &merchant)?;
        if m.status != MerchantStatus::Active && m.status != MerchantStatus::Suspended {
            return Err(Error::BadState);
        }
        if licence_expires <= env.ledger().timestamp() {
            return Err(Error::LicenceExpired);
        }
        m.licence_expires = licence_expires;
        store(&env, &merchant, &m);
        Ok(())
    }

    // ------------------------------------------------------------ views

    pub fn get(env: Env, merchant: Address) -> Option<Merchant> {
        env.storage()
            .persistent()
            .get(&DataKey::Merchant(merchant))
    }

    /// `Active` and licence not expired and at least one requested category bit held.
    pub fn is_active(env: Env, merchant: Address, category: u32) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Merchant>(&DataKey::Merchant(merchant))
        {
            Some(m) => {
                m.status == MerchantStatus::Active
                    && env.ledger().timestamp() < m.licence_expires
                    && m.categories & category != 0
            }
            None => false,
        }
    }

    pub fn count(env: Env) -> u32 {
        count(&env)
    }

    pub fn known_mask(env: Env) -> u32 {
        known_mask(&env)
    }

    pub fn is_verifier(env: Env, verifier: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Verifier(verifier))
            .unwrap_or(false)
    }

    pub fn licence_owner(env: Env, licence_hash: BytesN<32>) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Licence(licence_hash))
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        admin(&env)
    }
}

mod test;
