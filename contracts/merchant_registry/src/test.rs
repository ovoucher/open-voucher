#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
    MockAuthInvoke,
};
use soroban_sdk::{Bytes, BytesN, Env, IntoVal, Symbol};

/// 2026-09-01T00:00:00+03:00 (programme day 0 in the seed data).
const T0: u64 = 1_788_210_000;
const DAY: u64 = 86_400;
const YEAR: u64 = 365 * DAY;

/// Licence normalisation vectors shared with `app/test/onboarding.test.ts`.
/// `normalise("NCC", "BP/2026/00123") == normalise("ncc", "bp 2026 00123") == "NCC:BP202600123"`.
const VECTORS: [(&str, &str); 3] = [
    (
        "NCC:BP202600123",
        "160011bc5c862bceab119ecf8471d307ba03716fa1105c27271a6f35f6444874",
    ),
    (
        "PCPB:PCPBAD20260456",
        "de8ffee03039527ac351a89e53442496754f6c702f3f00172a60e65bf4c7dd01",
    ),
    (
        "KSM:SBP2026KSM0071",
        "17edbd24b14418700f3067487df78a4c5af4aad6199706a468e9eda6bd46ed5d",
    ),
];

fn lic(env: &Env, normalised: &str) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from_slice(env, normalised.as_bytes()))
        .into()
}

fn hex32(env: &Env, hex: &str) -> BytesN<32> {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &out)
}

struct T {
    env: Env,
    id: Address,
    c: MerchantRegistryClient<'static>,
    admin: Address,
    verifier: Address,
}

fn setup() -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = T0);
    let id = env.register(MerchantRegistry, ());
    let c = MerchantRegistryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let verifier = Address::generate(&env);
    c.init(&admin);
    c.set_verifier(&verifier, &true);
    T {
        env,
        id,
        c,
        admin,
        verifier,
    }
}

impl T {
    /// Apply + approve a self-onboarded merchant.
    fn onboard(&self, licence: &str, categories: u32) -> Address {
        let m = Address::generate(&self.env);
        self.c.apply(&m, &lic(&self.env, licence), &categories);
        self.c.approve(&self.verifier, &m, &(T0 + YEAR));
        m
    }

    /// Replace mock_all_auths with a single mocked authorisation for `who`.
    fn only_auth(&self, who: &Address, fn_name: &str, args: soroban_sdk::Vec<soroban_sdk::Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    fn event_names(&self) -> std::vec::Vec<std::string::String> {
        use soroban_sdk::xdr;
        self.env
            .events()
            .all()
            .filter_by_contract(&self.id)
            .events()
            .iter()
            .map(|e| {
                let xdr::ContractEventBody::V0(v0) = &e.body;
                match v0.topics.first() {
                    Some(xdr::ScVal::Symbol(s)) => s.0.to_utf8_string_lossy(),
                    _ => std::string::String::from("?"),
                }
            })
            .collect()
    }
}

// ------------------------------------------------------------------ init

#[test]
fn init_twice_fails() {
    let t = setup();
    assert_eq!(
        t.c.try_init(&Address::generate(&t.env)),
        Err(Ok(Error::AlreadyInitialised))
    );
    assert_eq!(t.c.admin(), t.admin);
    assert_eq!(t.c.known_mask(), KNOWN_MASK);
    assert_eq!(t.c.count(), 0);
}

#[test]
fn calls_before_init_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(MerchantRegistry, ());
    let c = MerchantRegistryClient::new(&env, &id);
    let m = Address::generate(&env);
    assert_eq!(
        c.try_apply(&m, &lic(&env, "NCC:BP202600123"), &FOOD),
        Err(Ok(Error::NotInitialised))
    );
    assert_eq!(
        c.try_set_verifier(&m, &true),
        Err(Ok(Error::NotInitialised))
    );
}

// ------------------------------------------------------------------ verifier / mask

#[test]
fn set_verifier_admin_only() {
    let t = setup();
    let v2 = Address::generate(&t.env);
    let mallory = Address::generate(&t.env);
    t.only_auth(&mallory, "set_verifier", (&v2, true).into_val(&t.env));
    assert!(t.c.try_set_verifier(&v2, &true).is_err());
    assert!(!t.c.is_verifier(&v2));

    t.only_auth(&t.admin, "set_verifier", (&v2, true).into_val(&t.env));
    t.c.set_verifier(&v2, &true);
    assert_eq!(
        t.env.auths(),
        std::vec![(
            t.admin.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    t.id.clone(),
                    Symbol::new(&t.env, "set_verifier"),
                    (&v2, true).into_val(&t.env)
                )),
                sub_invocations: std::vec![]
            }
        )]
    );
    assert!(t.c.is_verifier(&v2));
}

#[test]
fn set_known_mask_can_add_but_not_shrink() {
    let t = setup();
    assert_eq!(t.c.try_set_known_mask(&FOOD), Err(Ok(Error::MaskShrink)));
    assert_eq!(t.c.try_set_known_mask(&4), Err(Ok(Error::MaskShrink)));
    t.c.set_known_mask(&(KNOWN_MASK | 4));
    assert_eq!(t.c.known_mask(), 7);
    // the new bit is now accepted
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "NCC:SHELTER1"), &4);
    assert_eq!(t.c.try_set_known_mask(&3), Err(Ok(Error::MaskShrink)));
}

#[test]
fn set_known_mask_admin_only() {
    let t = setup();
    let mallory = Address::generate(&t.env);
    t.only_auth(&mallory, "set_known_mask", (7u32,).into_val(&t.env));
    assert!(t.c.try_set_known_mask(&7).is_err());
    assert_eq!(t.c.known_mask(), 3);
}

// ------------------------------------------------------------------ enrol

#[test]
fn enrol_by_admin_goes_straight_to_active() {
    let t = setup();
    let m = Address::generate(&t.env);
    let h = lic(&t.env, "NCC:BP202600123");
    t.only_auth(&t.admin, "enrol", (&m, &h, FOOD, T0 + YEAR).into_val(&t.env));
    t.c.enrol(&m, &h, &FOOD, &(T0 + YEAR));
    assert_eq!(t.env.auths()[0].0, t.admin);
    assert_eq!(t.event_names(), std::vec!["enrolled"]);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Active);
    assert!(!rec.self_onboarded);
    assert_eq!(rec.activated_at, T0);
    assert!(t.c.is_active(&m, &FOOD));
    assert!(!t.c.is_active(&m, &AGRI));
    assert_eq!(t.c.count(), 1);
    assert_eq!(t.c.licence_owner(&h), Some(m.clone()));
}

#[test]
fn enrol_by_non_admin_fails() {
    let t = setup();
    let m = Address::generate(&t.env);
    let mallory = Address::generate(&t.env);
    let h = lic(&t.env, "NCC:BP202600123");
    t.only_auth(&mallory, "enrol", (&m, &h, FOOD, T0 + YEAR).into_val(&t.env));
    assert!(t.c.try_enrol(&m, &h, &FOOD, &(T0 + YEAR)).is_err());
    assert_eq!(t.c.get(&m), None);
    assert_eq!(t.c.count(), 0);
}

#[test]
fn enrol_validates_inputs() {
    let t = setup();
    let m = Address::generate(&t.env);
    let h = lic(&t.env, "NCC:BP202600123");
    assert_eq!(
        t.c.try_enrol(&m, &h, &0, &(T0 + YEAR)),
        Err(Ok(Error::UnknownCategory))
    );
    assert_eq!(
        t.c.try_enrol(&m, &h, &8, &(T0 + YEAR)),
        Err(Ok(Error::UnknownCategory))
    );
    assert_eq!(
        t.c.try_enrol(&m, &h, &FOOD, &T0),
        Err(Ok(Error::LicenceExpired))
    );
    t.c.enrol(&m, &h, &FOOD, &(T0 + YEAR));
    assert_eq!(
        t.c.try_enrol(&m, &lic(&t.env, "NCC:OTHER"), &FOOD, &(T0 + YEAR)),
        Err(Ok(Error::AlreadyExists))
    );
    let other = Address::generate(&t.env);
    assert_eq!(
        t.c.try_enrol(&other, &h, &FOOD, &(T0 + YEAR)),
        Err(Ok(Error::LicenceInUse))
    );
}

// ------------------------------------------------------------------ apply / approve

#[test]
fn apply_then_approve_happy_path() {
    let t = setup();
    let m = Address::generate(&t.env);
    let h = lic(&t.env, "KSM:SBP2026KSM0071");
    t.only_auth(&m, "apply", (&m, &h, FOOD | AGRI).into_val(&t.env));
    t.c.apply(&m, &h, &(FOOD | AGRI));
    assert_eq!(t.env.auths()[0].0, m);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Pending);
    assert!(rec.self_onboarded);
    assert_eq!(rec.applied_at, T0);
    assert!(!t.c.is_active(&m, &FOOD));

    t.env.ledger().with_mut(|l| l.timestamp = T0 + 240); // four minutes later
    t.only_auth(
        &t.verifier,
        "approve",
        (&t.verifier, &m, T0 + YEAR).into_val(&t.env),
    );
    t.c.approve(&t.verifier, &m, &(T0 + YEAR));
    assert_eq!(t.env.auths()[0].0, t.verifier);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Active);
    assert_eq!(rec.activated_at, T0 + 240);
    assert_eq!(rec.licence_expires, T0 + YEAR);
    assert!(t.c.is_active(&m, &FOOD));
    assert!(t.c.is_active(&m, &AGRI));
    assert_eq!(t.c.count(), 1);
}

#[test]
fn apply_requires_merchant_auth() {
    let t = setup();
    let m = Address::generate(&t.env);
    let squatter = Address::generate(&t.env);
    let h = lic(&t.env, "NCC:BP202600123");
    t.only_auth(&squatter, "apply", (&m, &h, FOOD).into_val(&t.env));
    assert!(t.c.try_apply(&m, &h, &FOOD).is_err());
    assert_eq!(t.c.get(&m), None);
}

#[test]
fn approve_by_unknown_or_disabled_verifier_fails() {
    let t = setup();
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "NCC:BP202600123"), &FOOD);
    let stranger = Address::generate(&t.env);
    assert_eq!(
        t.c.try_approve(&stranger, &m, &(T0 + YEAR)),
        Err(Ok(Error::NotVerifier))
    );
    t.c.set_verifier(&t.verifier, &false);
    assert_eq!(
        t.c.try_approve(&t.verifier, &m, &(T0 + YEAR)),
        Err(Ok(Error::NotVerifier))
    );
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Pending);
}

#[test]
fn approve_requires_the_verifiers_own_auth() {
    let t = setup();
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "NCC:BP202600123"), &FOOD);
    // the merchant tries to approve itself by naming the verifier
    t.only_auth(&m, "approve", (&t.verifier, &m, T0 + YEAR).into_val(&t.env));
    assert!(t.c.try_approve(&t.verifier, &m, &(T0 + YEAR)).is_err());
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Pending);
}

#[test]
fn approve_with_past_expiry_fails() {
    let t = setup();
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "NCC:BP202600123"), &FOOD);
    assert_eq!(
        t.c.try_approve(&t.verifier, &m, &(T0 - DAY)),
        Err(Ok(Error::LicenceExpired))
    );
    assert_eq!(
        t.c.try_approve(&t.verifier, &m, &T0),
        Err(Ok(Error::LicenceExpired))
    );
}

#[test]
fn approve_only_from_pending() {
    let t = setup();
    let m = t.onboard("NCC:BP202600123", FOOD);
    assert_eq!(
        t.c.try_approve(&t.verifier, &m, &(T0 + YEAR)),
        Err(Ok(Error::BadState))
    );
    let ghost = Address::generate(&t.env);
    assert_eq!(
        t.c.try_approve(&t.verifier, &ghost, &(T0 + YEAR)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn duplicate_licence_for_another_address_fails() {
    let t = setup();
    let h = lic(&t.env, "NCC:BP202600123");
    let a = Address::generate(&t.env);
    let b = Address::generate(&t.env);
    t.c.apply(&a, &h, &FOOD);
    assert_eq!(t.c.try_apply(&b, &h, &FOOD), Err(Ok(Error::LicenceInUse)));
    // same address re-applying while pending is AlreadyExists
    assert_eq!(t.c.try_apply(&a, &h, &FOOD), Err(Ok(Error::AlreadyExists)));
}

#[test]
fn zero_or_unknown_category_fails() {
    let t = setup();
    let m = Address::generate(&t.env);
    let h = lic(&t.env, "NCC:BP202600123");
    assert_eq!(t.c.try_apply(&m, &h, &0), Err(Ok(Error::UnknownCategory)));
    assert_eq!(t.c.try_apply(&m, &h, &4), Err(Ok(Error::UnknownCategory)));
    assert_eq!(
        t.c.try_apply(&m, &h, &(FOOD | 16)),
        Err(Ok(Error::UnknownCategory))
    );
    assert_eq!(t.c.get(&m), None);
}

// ------------------------------------------------------------------ reject

#[test]
fn reject_frees_the_licence() {
    let t = setup();
    let h = lic(&t.env, "NCC:BP202600123");
    let a = Address::generate(&t.env);
    t.c.apply(&a, &h, &FOOD);
    assert_eq!(t.c.count(), 1);
    t.c.reject(&t.verifier, &a, &41);
    assert_eq!(t.event_names(), std::vec!["rejected"]);
    assert_eq!(t.c.get(&a), None);
    assert_eq!(t.c.licence_owner(&h), None);
    assert_eq!(t.c.count(), 0);
    let b = Address::generate(&t.env);
    t.c.apply(&b, &h, &FOOD);
    assert_eq!(t.c.licence_owner(&h), Some(b));
}

#[test]
fn reject_requires_enabled_verifier_and_pending() {
    let t = setup();
    let a = Address::generate(&t.env);
    t.c.apply(&a, &lic(&t.env, "NCC:BP202600123"), &FOOD);
    let stranger = Address::generate(&t.env);
    assert_eq!(
        t.c.try_reject(&stranger, &a, &1),
        Err(Ok(Error::NotVerifier))
    );
    t.only_auth(&a, "reject", (&t.verifier, &a, 1u32).into_val(&t.env));
    assert!(t.c.try_reject(&t.verifier, &a, &1).is_err());
    t.env.mock_all_auths();
    t.c.approve(&t.verifier, &a, &(T0 + YEAR));
    assert_eq!(
        t.c.try_reject(&t.verifier, &a, &1),
        Err(Ok(Error::BadState))
    );
}

// ------------------------------------------------------------------ suspend / reinstate / revoke

#[test]
fn suspend_reinstate_round_trip() {
    let t = setup();
    let m = t.onboard("NCC:BP202600123", FOOD);
    t.c.suspend(&m, &17);
    assert_eq!(t.event_names(), std::vec!["suspended"]);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Suspended);
    assert_eq!(rec.reason, 17);
    assert!(!t.c.is_active(&m, &FOOD));
    assert_eq!(t.c.try_suspend(&m, &17), Err(Ok(Error::BadState)));
    t.c.reinstate(&m);
    assert_eq!(t.event_names(), std::vec!["reinstated"]);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Active);
    assert_eq!(rec.reason, 0);
    assert!(t.c.is_active(&m, &FOOD));
    assert_eq!(t.c.try_reinstate(&m), Err(Ok(Error::BadState)));
}

#[test]
fn suspend_from_pending_is_bad_state() {
    let t = setup();
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "NCC:BP202600123"), &FOOD);
    assert_eq!(t.c.try_suspend(&m, &1), Err(Ok(Error::BadState)));
    assert_eq!(
        t.c.try_suspend(&Address::generate(&t.env), &1),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn admin_actions_by_non_admin_fail() {
    let t = setup();
    let m = t.onboard("NCC:BP202600123", FOOD);
    let mallory = Address::generate(&t.env);

    t.only_auth(&mallory, "suspend", (&m, 1u32).into_val(&t.env));
    assert!(t.c.try_suspend(&m, &1).is_err());
    t.only_auth(&mallory, "revoke", (&m, 1u32).into_val(&t.env));
    assert!(t.c.try_revoke(&m, &1).is_err());
    t.only_auth(&mallory, "set_categories", (&m, 3u32).into_val(&t.env));
    assert!(t.c.try_set_categories(&m, &3).is_err());
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Active);
    assert_eq!(t.c.get(&m).unwrap().categories, FOOD);

    t.env.mock_all_auths();
    t.c.suspend(&m, &1);
    t.only_auth(&mallory, "reinstate", (&m,).into_val(&t.env));
    assert!(t.c.try_reinstate(&m).is_err());
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Suspended);

    t.only_auth(&t.admin, "reinstate", (&m,).into_val(&t.env));
    t.c.reinstate(&m);
    assert_eq!(t.env.auths()[0].0, t.admin);
}

#[test]
fn revoke_is_terminal_and_retires_the_licence() {
    let t = setup();
    let h = lic(&t.env, "NCC:BP202600123");
    let m = t.onboard("NCC:BP202600123", FOOD);
    t.c.revoke(&m, &99);
    let rec = t.c.get(&m).unwrap();
    assert_eq!(rec.status, MerchantStatus::Revoked);
    assert_eq!(rec.reason, 99);
    assert!(!t.c.is_active(&m, &FOOD));
    assert_eq!(t.c.try_revoke(&m, &99), Err(Ok(Error::BadState)));
    assert_eq!(t.c.try_reinstate(&m), Err(Ok(Error::BadState)));
    assert_eq!(t.c.try_suspend(&m, &1), Err(Ok(Error::BadState)));
    assert_eq!(
        t.c.try_approve(&t.verifier, &m, &(T0 + YEAR)),
        Err(Ok(Error::BadState))
    );
    // the licence cannot be re-applied from a new address ...
    let fresh = Address::generate(&t.env);
    assert_eq!(t.c.try_apply(&fresh, &h, &FOOD), Err(Ok(Error::LicenceInUse)));
    // ... nor by the revoked address itself
    assert_eq!(t.c.try_apply(&m, &h, &FOOD), Err(Ok(Error::LicenceInUse)));
    assert_eq!(t.c.licence_owner(&h), Some(m.clone()));
}

#[test]
fn revoke_from_pending_and_suspended() {
    let t = setup();
    let p = Address::generate(&t.env);
    t.c.apply(&p, &lic(&t.env, "NCC:P1"), &FOOD);
    t.c.revoke(&p, &3);
    assert_eq!(t.c.get(&p).unwrap().status, MerchantStatus::Revoked);
    let s = t.onboard("NCC:S1", FOOD);
    t.c.suspend(&s, &2);
    t.c.revoke(&s, &3);
    assert_eq!(t.event_names(), std::vec!["revoked"]);
    assert_eq!(t.c.get(&s).unwrap().status, MerchantStatus::Revoked);
}

#[test]
fn revoked_address_may_reapply_with_a_different_licence() {
    let t = setup();
    let m = t.onboard("NCC:OLD1", FOOD);
    t.c.revoke(&m, &5);
    t.c.apply(&m, &lic(&t.env, "NCC:NEW1"), &FOOD);
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Pending);
    assert_eq!(t.c.count(), 1);
}

// ------------------------------------------------------------------ categories / licence

#[test]
fn set_categories_by_admin() {
    let t = setup();
    let m = t.onboard("NCC:BP202600123", FOOD);
    assert_eq!(t.c.try_set_categories(&m, &0), Err(Ok(Error::UnknownCategory)));
    t.c.set_categories(&m, &(FOOD | AGRI));
    assert!(t.c.is_active(&m, &AGRI));
    t.c.revoke(&m, &1);
    assert_eq!(t.c.try_set_categories(&m, &FOOD), Err(Ok(Error::BadState)));
}

#[test]
fn is_active_false_after_licence_expiry_and_for_wrong_category() {
    let t = setup();
    let m = Address::generate(&t.env);
    t.c.apply(&m, &lic(&t.env, "PCPB:PCPBAD20260456"), &AGRI);
    t.c.approve(&t.verifier, &m, &(T0 + 30 * DAY));
    assert!(t.c.is_active(&m, &AGRI));
    assert!(!t.c.is_active(&m, &FOOD));
    assert!(!t.c.is_active(&Address::generate(&t.env), &AGRI));
    t.env.ledger().with_mut(|l| l.timestamp = T0 + 30 * DAY - 1);
    assert!(t.c.is_active(&m, &AGRI));
    t.env.ledger().with_mut(|l| l.timestamp = T0 + 30 * DAY);
    assert!(!t.c.is_active(&m, &AGRI));
    // state is unchanged; only the view reflects expiry
    assert_eq!(t.c.get(&m).unwrap().status, MerchantStatus::Active);
    // renewal restores it
    t.c.renew_licence(&t.verifier, &m, &(T0 + 400 * DAY));
    assert!(t.c.is_active(&m, &AGRI));
}

#[test]
fn renew_licence_rules() {
    let t = setup();
    let m = t.onboard("NCC:BP202600123", FOOD);
    let stranger = Address::generate(&t.env);
    assert_eq!(
        t.c.try_renew_licence(&stranger, &m, &(T0 + 2 * YEAR)),
        Err(Ok(Error::NotVerifier))
    );
    assert_eq!(
        t.c.try_renew_licence(&t.verifier, &m, &T0),
        Err(Ok(Error::LicenceExpired))
    );
    let p = Address::generate(&t.env);
    t.c.apply(&p, &lic(&t.env, "NCC:P2"), &FOOD);
    assert_eq!(
        t.c.try_renew_licence(&t.verifier, &p, &(T0 + YEAR)),
        Err(Ok(Error::BadState))
    );
    t.c.renew_licence(&t.verifier, &m, &(T0 + 2 * YEAR));
    assert_eq!(t.c.get(&m).unwrap().licence_expires, T0 + 2 * YEAR);
}

#[test]
fn licence_hash_vectors_match_typescript() {
    let env = Env::default();
    for (normalised, hex) in VECTORS.iter() {
        assert_eq!(lic(&env, normalised), hex32(&env, hex), "{normalised}");
    }
}

#[test]
fn events_are_published_for_each_transition() {
    let t = setup();
    let a = Address::generate(&t.env);
    t.c.apply(&a, &lic(&t.env, "NCC:A"), &FOOD);
    t.c.approve(&t.verifier, &a, &(T0 + YEAR));
    assert_eq!(t.event_names(), std::vec!["approved"]);
    let b = Address::generate(&t.env);
    t.c.apply(&b, &lic(&t.env, "NCC:B"), &FOOD);
    assert_eq!(t.event_names(), std::vec!["applied"]);
}
