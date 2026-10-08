#![cfg(test)]
extern crate std;

use super::*;
use merchant_registry::{MerchantRegistry, MerchantRegistryClient, AGRI, FOOD};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, EnvTestConfig, Events as _,
    IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{token, xdr, Bytes, BytesN, Env, IntoVal, Symbol};

/// One voucher / USDC unit (7 decimals).
const UNIT: i128 = 10_000_000;
/// 2026-09-01T00:00:00+03:00, programme day 0 of the seed data (KE-PILOT-SIM).
const T0: u64 = 1_788_210_000;
const DAY: u64 = 86_400;
const YEAR: u64 = 365 * DAY;
/// Seed calendar: spending expires at the end of day 28, redemption closes at the end
/// of day 42 (2026-10-13T23:59:59+03:00), as in data/seed/programme.json.
const REDEEM_DEADLINE: u64 = T0 + 43 * DAY - 1;

fn usd(cents: i128) -> i128 {
    cents * UNIT / 100
}

fn lic(env: &Env, s: &str) -> BytesN<32> {
    env.crypto().sha256(&Bytes::from_slice(env, s.as_bytes())).into()
}

struct World {
    env: Env,
    agency: Address,
    verifier: Address,
    registry: Address,
    reg: MerchantRegistryClient<'static>,
    voucher: Address,
    vsac: token::StellarAssetClient<'static>,
    vtok: token::TokenClient<'static>,
    usdc: Address,
    usac: token::StellarAssetClient<'static>,
    utok: token::TokenClient<'static>,
    pool: Address,
    c: RedeemPoolClient<'static>,
    licence_seq: core::cell::Cell<u32>,
}

impl World {
    fn new() -> World {
        Self::with_env(Env::default(), true)
    }

    fn with_env(env: Env, set_pool_as_admin: bool) -> World {
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = T0);
        let agency = Address::generate(&env);
        let verifier = Address::generate(&env);

        let registry = env.register(MerchantRegistry, ());
        let reg = MerchantRegistryClient::new(&env, &registry);
        reg.init(&agency);
        reg.set_verifier(&verifier, &true);

        // Voucher SAC: issuer flags AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED
        // are set on the issuer *before* any balance exists, as the classic issuer
        // setup script does on testnet.
        let v = env.register_stellar_asset_contract_v2(agency.clone());
        let issuer = v.issuer();
        issuer.set_flag(IssuerFlags::RequiredFlag);
        issuer.set_flag(IssuerFlags::RevocableFlag);
        issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);
        let voucher = v.address();
        let vsac = token::StellarAssetClient::new(&env, &voucher);
        let vtok = token::TokenClient::new(&env, &voucher);

        let u = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let usdc = u.address();
        let usac = token::StellarAssetClient::new(&env, &usdc);
        let utok = token::TokenClient::new(&env, &usdc);

        let pool = env.register(RedeemPool, ());
        let c = RedeemPoolClient::new(&env, &pool);
        c.init(&agency, &registry, &voucher, &usdc, &FOOD, &REDEEM_DEADLINE);
        if set_pool_as_admin {
            vsac.set_admin(&pool);
        }
        World {
            env,
            agency,
            verifier,
            registry,
            reg,
            voucher,
            vsac,
            vtok,
            usdc,
            usac,
            utok,
            pool,
            c,
            licence_seq: core::cell::Cell::new(0),
        }
    }

    fn next_licence(&self) -> BytesN<32> {
        let n = self.licence_seq.get() + 1;
        self.licence_seq.set(n);
        let s = std::format!("NCC:BP2026{n:05}");
        lic(&self.env, &s)
    }

    /// A legacy vendor enrolled directly by the agency.
    fn legacy(&self, categories: u32) -> Address {
        let m = Address::generate(&self.env);
        self.reg
            .enrol(&m, &self.next_licence(), &categories, &(T0 + YEAR));
        m
    }

    /// A self-onboarded merchant (apply + verifier approve).
    fn self_onboarded(&self, categories: u32) -> Address {
        let m = Address::generate(&self.env);
        self.reg.apply(&m, &self.next_licence(), &categories);
        self.reg.approve(&self.verifier, &m, &(T0 + YEAR));
        m
    }

    /// Emulates the SEP-8 sandwich for a payment of vouchers into `to`:
    /// authorise → move value → back to the de-authorised resting state.
    /// Value arrives by issuer mint here (disbursement + recipient payment collapsed),
    /// which is equivalent for the merchant's balance.
    fn credit_vouchers(&self, to: &Address, amount: i128) {
        self.vsac.set_authorized(to, &true);
        self.vsac.mint(to, &amount);
        self.vsac.set_authorized(to, &false);
    }

    /// Recipient → merchant payment inside an authorise/pay/de-authorise sandwich.
    fn sandwich_pay(&self, from: &Address, to: &Address, amount: i128) {
        self.vsac.set_authorized(from, &true);
        self.vsac.set_authorized(to, &true);
        self.vtok.transfer(from, to, &amount);
        self.vsac.set_authorized(to, &false);
        self.vsac.set_authorized(from, &false);
    }

    fn fund(&self, amount: i128) {
        self.usac.mint(&self.agency, &amount);
        self.c.fund(&self.agency, &amount);
    }

    fn totals(&self) -> Totals {
        self.c.totals()
    }

    fn event_names(&self) -> std::vec::Vec<std::string::String> {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.pool)
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

    fn assert_invariants(&self) {
        let t = self.totals();
        assert_eq!(t.clawed, t.paid + t.queued, "clawed == paid + queued");
        assert_eq!(
            self.utok.balance(&self.pool),
            t.funded - t.paid - t.withdrawn,
            "float == funded - paid - withdrawn"
        );
        assert!(t.funded >= 0 && t.paid >= 0 && t.queued >= 0 && t.clawed >= 0 && t.withdrawn >= 0);
        let (h, tl) = self.c.queue();
        assert!(h <= tl);
        let mut waiting = 0i128;
        for id in 0..tl {
            match self.c.claim(&id) {
                Some(cl) => {
                    assert!(id >= h, "claim {id} below head still stored");
                    assert!(cl.amount > 0);
                    waiting += cl.amount;
                }
                None => assert!(id < h, "claim {id} missing from the queue"),
            }
        }
        assert_eq!(waiting, t.queued, "sum of waiting claims == queued");
    }
}

// ------------------------------------------------------------------ init / fund

#[test]
fn init_twice_fails_and_config_is_readable() {
    let w = World::new();
    assert_eq!(
        w.c.try_init(&w.agency, &w.registry, &w.voucher, &w.usdc, &AGRI, &0),
        Err(Ok(Error::AlreadyInitialised))
    );
    let cfg = w.c.config();
    assert_eq!(cfg.category, FOOD);
    assert_eq!(cfg.redeem_deadline, REDEEM_DEADLINE);
    assert_eq!(cfg.voucher, w.voucher);
    assert_eq!(w.vsac.admin(), w.pool);
}

#[test]
fn calls_before_init_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let pool = env.register(RedeemPool, ());
    let c = RedeemPoolClient::new(&env, &pool);
    let a = Address::generate(&env);
    assert_eq!(c.try_fund(&a, &1), Err(Ok(Error::NotInitialised)));
    assert_eq!(c.try_redeem(&a, &1), Err(Ok(Error::NotInitialised)));
    assert_eq!(c.try_settle_queue(&1), Err(Ok(Error::NotInitialised)));
    assert_eq!(c.try_coverage(), Err(Ok(Error::NotInitialised)));
}

#[test]
fn fund_moves_usdc_and_counts() {
    let w = World::new();
    w.usac.mint(&w.agency, &usd(300_000));
    w.c.fund(&w.agency, &usd(255_000));
    assert_eq!(w.event_names(), std::vec!["fund"]);
    assert_eq!(w.utok.balance(&w.pool), usd(255_000));
    assert_eq!(w.totals().funded, usd(255_000));
    assert_eq!(w.c.coverage().float, usd(255_000));
    assert_eq!(w.c.try_fund(&w.agency, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(w.c.try_fund(&w.agency, &-5), Err(Ok(Error::InvalidAmount)));
    w.assert_invariants();
}

#[test]
fn fund_requires_the_funders_auth() {
    let w = World::new();
    w.usac.mint(&w.agency, &usd(1_000));
    let mallory = Address::generate(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "fund",
            args: (&w.agency, usd(1_000)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.c.try_fund(&w.agency, &usd(1_000)).is_err());
    assert_eq!(w.utok.balance(&w.agency), usd(1_000));
    assert_eq!(w.totals().funded, 0);
}

// ------------------------------------------------------------------ redeem

#[test]
fn par_redemption_burns_vouchers_and_pays_usdc() {
    let w = World::new();
    w.fund(usd(50_000));
    let m = w.legacy(FOOD);
    let recipient = Address::generate(&w.env);
    w.credit_vouchers(&recipient, usd(10_000));
    w.sandwich_pay(&recipient, &m, 100 * UNIT);
    let supply_before = w.vtok.balance(&m) + w.vtok.balance(&recipient);
    assert_eq!(w.vtok.balance(&m), 1_000_000_000); // 100.0000000
    assert!(!w.vsac.authorized(&m), "merchant rests de-authorised");

    let out = w.c.redeem(&m, &1_000_000_000);
    assert_eq!(out, RedeemOutcome::Paid(1_000_000_000));
    assert_eq!(w.event_names(), std::vec!["redeem"]);
    assert_eq!(w.vtok.balance(&m), 0);
    assert_eq!(w.utok.balance(&m), 1_000_000_000);
    let supply_after = w.vtok.balance(&m) + w.vtok.balance(&recipient);
    assert_eq!(supply_before - supply_after, 1_000_000_000, "vouchers burned, not moved");
    assert_eq!(w.vtok.balance(&w.pool), 0, "pool holds no vouchers");
    let t = w.totals();
    assert_eq!((t.clawed, t.paid, t.queued), (100 * UNIT, 100 * UNIT, 0));
    assert_eq!(w.c.coverage().float, usd(50_000) - 100 * UNIT);
    w.assert_invariants();
}

#[test]
fn redeem_requires_the_merchants_auth() {
    let w = World::new();
    w.fund(usd(10_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(2_000));
    let mallory = Address::generate(&w.env);

    w.env.mock_auths(&[MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "redeem",
            args: (&m, usd(2_000)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.c.try_redeem(&m, &usd(2_000)).is_err());
    assert_eq!(w.vtok.balance(&m), usd(2_000));

    // Only the merchant's own authorisation of the root call is needed: the pool
    // authorises its SAC clawback and USDC transfer as the direct caller.
    w.env.mock_auths(&[MockAuth {
        address: &m,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "redeem",
            args: (&m, usd(2_000)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(w.c.redeem(&m, &usd(2_000)), RedeemOutcome::Paid(usd(2_000)));
    assert_eq!(
        w.env.auths(),
        std::vec![(
            m.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.pool.clone(),
                    Symbol::new(&w.env, "redeem"),
                    (&m, usd(2_000)).into_val(&w.env)
                )),
                sub_invocations: std::vec![]
            }
        )]
    );
}

#[test]
fn inactive_merchants_cannot_redeem_and_change_nothing() {
    let w = World::new();
    w.fund(usd(10_000));

    let pending = Address::generate(&w.env);
    w.reg.apply(&pending, &w.next_licence(), &FOOD);
    let suspended = w.legacy(FOOD);
    w.reg.suspend(&suspended, &7);
    let revoked = w.legacy(FOOD);
    w.reg.revoke(&revoked, &9);
    let expiring = Address::generate(&w.env);
    w.reg.apply(&expiring, &w.next_licence(), &FOOD);
    w.reg.approve(&w.verifier, &expiring, &(T0 + 10 * DAY));
    let agri_only = w.legacy(AGRI);
    let unregistered = Address::generate(&w.env);

    let all = [&pending, &suspended, &revoked, &expiring, &agri_only, &unregistered];
    for m in all.iter() {
        w.credit_vouchers(m, usd(500));
    }
    w.env.ledger().with_mut(|l| l.timestamp = T0 + 10 * DAY); // licence of `expiring` ends
    let before = w.totals();
    for m in all.iter() {
        assert_eq!(
            w.c.try_redeem(m, &usd(500)),
            Err(Ok(Error::MerchantNotActive))
        );
        assert_eq!(w.vtok.balance(m), usd(500));
        assert_eq!(w.utok.balance(m), 0);
    }
    assert_eq!(w.totals(), before);
    assert_eq!(w.c.queue(), (0, 0));
    w.assert_invariants();
}

#[test]
fn invalid_amount_fails() {
    let w = World::new();
    w.fund(usd(1_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(500));
    assert_eq!(w.c.try_redeem(&m, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(w.c.try_redeem(&m, &-1), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn more_than_balance_fails() {
    let w = World::new();
    w.fund(usd(1_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(21_240)); // 212.40
    assert_eq!(
        w.c.try_redeem(&m, &(usd(21_240) + 1)),
        Err(Ok(Error::InsufficientVouchers))
    );
    assert_eq!(w.vtok.balance(&m), usd(21_240));
}

#[test]
fn redemption_closes_after_the_deadline() {
    let w = World::new();
    w.fund(usd(10_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(1_000));
    w.env.ledger().with_mut(|l| l.timestamp = REDEEM_DEADLINE);
    assert_eq!(w.c.redeem(&m, &usd(400)), RedeemOutcome::Paid(usd(400)));
    w.env.ledger().with_mut(|l| l.timestamp = REDEEM_DEADLINE + 1);
    assert_eq!(
        w.c.try_redeem(&m, &usd(600)),
        Err(Ok(Error::RedemptionClosed))
    );
    assert_eq!(w.vtok.balance(&m), usd(600));
}

#[test]
fn redeem_fails_when_pool_is_not_the_sac_admin() {
    let w = World::with_env(Env::default(), false);
    w.fund(usd(1_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(100));
    w.env.mock_auths(&[MockAuth {
        address: &m,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "redeem",
            args: (&m, usd(100)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.c.try_redeem(&m, &usd(100)).is_err());
    assert_eq!(w.vtok.balance(&m), usd(100));
}

#[test]
fn shortfall_queues_and_later_claims_never_jump_the_queue() {
    let w = World::new();
    w.fund(usd(10_000)); // 100.00 float
    let a = w.legacy(FOOD);
    let b = w.self_onboarded(FOOD);
    w.credit_vouchers(&a, usd(15_000));
    w.credit_vouchers(&b, usd(2_000));

    let out = w.c.redeem(&a, &usd(15_000));
    assert_eq!(out, RedeemOutcome::Queued(0));
    assert_eq!(w.event_names(), std::vec!["shortfall", "redeem"]);
    // vouchers are burned even when queued: the merchant now holds a recorded claim
    assert_eq!(w.vtok.balance(&a), 0);
    let claim = w.c.claim(&0).unwrap();
    assert_eq!(claim.merchant, a);
    assert_eq!(claim.amount, usd(15_000));
    assert_eq!(claim.queued_at, T0);

    // 20.00 alone would be covered by the 100.00 float, but claim 0 is waiting
    assert_eq!(w.c.redeem(&b, &usd(2_000)), RedeemOutcome::Queued(1));
    assert_eq!(w.utok.balance(&b), 0);
    let cov = w.c.coverage();
    assert_eq!(cov.float, usd(10_000));
    assert_eq!(cov.queued, usd(17_000));
    assert_eq!(cov.paid, 0);
    assert_eq!(cov.clawed, usd(17_000));
    w.assert_invariants();
}

#[test]
fn settle_queue_pays_in_order_and_stops_at_first_unpayable() {
    let w = World::new();
    w.fund(usd(1_000));
    let ms: std::vec::Vec<Address> = (0..3).map(|_| w.legacy(FOOD)).collect();
    let amounts = [usd(5_000), usd(8_000), usd(1_000)];
    for (m, a) in ms.iter().zip(amounts.iter()) {
        w.credit_vouchers(m, *a);
        w.c.redeem(m, a);
    }
    assert_eq!(w.c.queue(), (0, 3));
    // nothing payable yet
    assert_eq!(w.c.settle_queue(&10), 0);

    w.fund(usd(6_000)); // float 70.00: covers claim 0 (50.00), not claim 1 (80.00)
    assert_eq!(w.c.settle_queue(&10), 1);
    assert_eq!(w.event_names(), std::vec!["settle"]);
    assert_eq!(w.utok.balance(&ms[0]), usd(5_000));
    assert_eq!(w.utok.balance(&ms[2]), 0, "claim 2 (10.00) must wait behind claim 1");
    assert_eq!(w.c.queue(), (1, 3));
    assert_eq!(w.c.claim(&0), None);
    w.assert_invariants();

    w.fund(usd(20_000));
    assert_eq!(w.c.settle_queue(&1), 1, "max bounds the batch");
    assert_eq!(w.utok.balance(&ms[1]), usd(8_000));
    assert_eq!(w.c.settle_queue(&5), 1);
    assert_eq!(w.utok.balance(&ms[2]), usd(1_000));
    assert_eq!(w.c.queue(), (3, 3));
    assert_eq!(w.c.settle_queue(&5), 0);
    // queue empty again: a new claim is paid immediately
    w.credit_vouchers(&ms[0], usd(100));
    assert_eq!(w.c.redeem(&ms[0], &usd(100)), RedeemOutcome::Paid(usd(100)));
    w.assert_invariants();
}

#[test]
fn settle_pays_a_claim_even_if_the_merchant_was_suspended_after_queueing() {
    // The vouchers were already burned against a recorded claim; suspension blocks new
    // redemptions, not settlement of an existing claim (see ARCHITECTURE.md).
    let w = World::new();
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(3_000));
    assert_eq!(w.c.redeem(&m, &usd(3_000)), RedeemOutcome::Queued(0));
    w.reg.suspend(&m, &4);
    w.fund(usd(3_000));
    assert_eq!(w.c.settle_queue(&5), 1);
    assert_eq!(w.utok.balance(&m), usd(3_000));
}

#[test]
fn deauthorised_balances_cannot_move_vouchers_but_can_be_clawed_back() {
    // Emulates verify-first items (a) and (c): at rest, a recipient or merchant balance is
    // de-authorised, so a plain transfer fails, while the pool (SAC admin) can still claw
    // back from it during `redeem`.
    let w = World::new();
    w.fund(usd(1_000));
    let m = w.legacy(FOOD);
    let r = Address::generate(&w.env);
    w.credit_vouchers(&r, usd(1_300));
    assert!(!w.vsac.authorized(&r));
    assert!(w.vtok.try_transfer(&r, &m, &usd(100)).is_err(), "no payment outside the sandwich");
    assert!(w.vtok.try_transfer(&r, &Address::generate(&w.env), &usd(100)).is_err(), "no P2P outside the sandwich");
    w.sandwich_pay(&r, &m, usd(450));
    assert!(!w.vsac.authorized(&m));
    assert!(w.vtok.try_transfer(&m, &r, &usd(1)).is_err(), "merchant cannot pass vouchers on");
    assert_eq!(w.c.redeem(&m, &usd(450)), RedeemOutcome::Paid(usd(450)));
    assert_eq!(w.vtok.balance(&r), usd(850));
}

// ------------------------------------------------------------------ deadline / surplus

#[test]
fn extend_deadline_must_be_later_and_admin_only() {
    let w = World::new();
    assert_eq!(
        w.c.try_extend_deadline(&REDEEM_DEADLINE),
        Err(Ok(Error::DeadlineNotLater))
    );
    assert_eq!(
        w.c.try_extend_deadline(&(REDEEM_DEADLINE - 1)),
        Err(Ok(Error::DeadlineNotLater))
    );
    let mallory = Address::generate(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "extend_deadline",
            args: (REDEEM_DEADLINE + DAY,).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.c.try_extend_deadline(&(REDEEM_DEADLINE + DAY)).is_err());
    w.env.mock_auths(&[MockAuth {
        address: &w.agency,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "extend_deadline",
            args: (REDEEM_DEADLINE + DAY,).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    w.c.extend_deadline(&(REDEEM_DEADLINE + DAY));
    assert_eq!(w.env.auths()[0].0, w.agency);
    assert_eq!(w.c.config().redeem_deadline, REDEEM_DEADLINE + DAY);
}

#[test]
fn withdraw_surplus_rules() {
    let w = World::new();
    w.fund(usd(1_000));
    let m = w.legacy(FOOD);
    w.credit_vouchers(&m, usd(2_000));
    let treasury = Address::generate(&w.env);

    // before the deadline
    assert_eq!(
        w.c.try_withdraw_surplus(&treasury, &usd(100)),
        Err(Ok(Error::WindowOpen))
    );
    assert_eq!(w.c.redeem(&m, &usd(2_000)), RedeemOutcome::Queued(0));

    // after the deadline but with a queue
    w.env.ledger().with_mut(|l| l.timestamp = REDEEM_DEADLINE + 1);
    assert_eq!(
        w.c.try_withdraw_surplus(&treasury, &usd(100)),
        Err(Ok(Error::QueueNotEmpty))
    );
    // settling works after the deadline too
    w.fund(usd(5_000));
    assert_eq!(w.c.settle_queue(&5), 1);
    assert_eq!(
        w.c.try_withdraw_surplus(&treasury, &usd(4_001)),
        Err(Ok(Error::InsufficientFloat))
    );
    assert_eq!(
        w.c.try_withdraw_surplus(&treasury, &0),
        Err(Ok(Error::InvalidAmount))
    );

    let mallory = Address::generate(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &w.pool,
            fn_name: "withdraw_surplus",
            args: (&mallory, usd(4_000)).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    assert!(w.c.try_withdraw_surplus(&mallory, &usd(4_000)).is_err());

    w.env.mock_all_auths();
    w.c.withdraw_surplus(&treasury, &usd(4_000));
    assert_eq!(w.event_names(), std::vec!["withdraw"]);
    assert_eq!(w.utok.balance(&treasury), usd(4_000));
    assert_eq!(w.utok.balance(&w.pool), 0);
    assert_eq!(w.totals().withdrawn, usd(4_000));
    w.assert_invariants();
}

// ------------------------------------------------------------------ property test

/// Deterministic xorshift64* generator (no extra crate).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn property_invariants_hold_over_random_sequences() {
    let mut rng = Rng(0x0F00_D5EE_D2026);
    let mut paid_calls = 0u32;
    let mut queued_calls = 0u32;
    let mut settled = 0u32;
    for _seq in 0..200 {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.cost_estimate().budget().reset_unlimited();
        let w = World::with_env(env, true);
        let ms: std::vec::Vec<Address> = (0..5)
            .map(|i| if i < 3 { w.legacy(FOOD) } else { w.self_onboarded(FOOD | AGRI) })
            .collect();
        let mut suspended = [false; 5];
        let mut last_head = 0u32;
        for _step in 0..25 {
            let t_before = w.totals();
            let (h0, t0) = w.c.queue();
            let float0 = w.utok.balance(&w.pool);
            match rng.below(7) {
                0 => {
                    let amt = 1 + rng.below(20_000) as i128 * 10_000; // up to 200.00
                    w.fund(amt);
                }
                1 | 2 => {
                    let i = rng.below(5) as usize;
                    let credit = rng.below(3) == 0;
                    if credit {
                        w.credit_vouchers(&ms[i], 1 + rng.below(15_000) as i128 * 10_000);
                    }
                    let bal = w.vtok.balance(&ms[i]);
                    let amt = match rng.below(4) {
                        0 => bal + 1,
                        1 => 0,
                        _ => 1 + (rng.next() as i128).rem_euclid(bal.max(1)),
                    };
                    let now = w.env.ledger().timestamp();
                    let r = w.c.try_redeem(&ms[i], &amt);
                    let should_fail = amt <= 0
                        || now > REDEEM_DEADLINE
                        || suspended[i]
                        || amt > bal;
                    match r {
                        Ok(Ok(RedeemOutcome::Paid(p))) => {
                            assert!(!should_fail);
                            assert_eq!(p, amt);
                            assert_eq!(h0, t0, "paid only when the queue is empty");
                            assert!(float0 >= amt);
                            paid_calls += 1;
                        }
                        Ok(Ok(RedeemOutcome::Queued(id))) => {
                            assert!(!should_fail);
                            assert_eq!(id, t0, "claims get the next tail id");
                            assert!(h0 != t0 || float0 < amt);
                            queued_calls += 1;
                        }
                        _ => {
                            assert!(should_fail, "unexpected refusal");
                            assert_eq!(w.totals(), t_before);
                        }
                    }
                }
                3 => {
                    let n = w.c.settle_queue(&(1 + rng.below(4) as u32));
                    settled += n;
                }
                4 => {
                    let i = rng.below(5) as usize;
                    if !suspended[i] {
                        w.reg.suspend(&ms[i], &1);
                        suspended[i] = true;
                    }
                }
                5 => {
                    let i = rng.below(5) as usize;
                    if suspended[i] {
                        w.reg.reinstate(&ms[i]);
                        suspended[i] = false;
                    }
                }
                _ => {
                    let dt = rng.below(12 * DAY);
                    w.env.ledger().with_mut(|l| l.timestamp += dt);
                }
            }
            w.assert_invariants();
            let (h, _) = w.c.queue();
            assert!(h >= last_head, "head never moves backwards");
            last_head = h;
        }
    }
    // the generator exercised every branch
    assert!(paid_calls > 100, "paid {paid_calls}");
    assert!(queued_calls > 50, "queued {queued_calls}");
    assert!(settled > 20, "settled {settled}");
}

mod scenario;
