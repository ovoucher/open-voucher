//! scenario_programme_cycle: the food pool of the simulated programme KE-PILOT-SIM,
//! with redemption totals mirrored from data/seed/pool-plan.json (derived from the
//! valid payments in spend-weeks-1-4.jsonl; the TypeScript scenario test checks that
//! the simulator reproduces the same rounds).
use super::*;

/// OVFOOD disbursed on day 1 to 391 recipients (sum of min(13, 3 x household size)).
const FOOD_DISBURSED: i128 = 40_850_000_000;
/// Day-1 float: 85% of disbursed (pool-plan.json OVFOOD.fund_day1).
const FUND_DAY1: i128 = 34_722_500_000;
/// Day-30 top-up (pool-plan.json OVFOOD.top_up).
const TOP_UP_DAY30: i128 = 6_127_500_000;

/// (programme day, [(merchant number, voucher balance redeemed)]) for OVFOOD.
/// Merchant numbers are M01..M30 from data/seed/merchants.csv.
const ROUNDS: [(u64, &[(u32, i128)]); 5] = [
    (7, &[(1, 764440000), (2, 281220000), (3, 613590000), (4, 600560000), (5, 772720000), (6, 609460000), (7, 271470000), (8, 223830000), (9, 765690000), (10, 484140000), (11, 847220000), (12, 832580000), (13, 218330000), (14, 302800000), (15, 175160000), (16, 475760000), (23, 543480000), (24, 52290000), (25, 113260000), (26, 211770000)]),
    (14, &[(1, 898710000), (2, 266530000), (3, 845700000), (4, 556840000), (5, 755690000), (6, 888610000), (7, 251920000), (8, 253480000), (9, 457090000), (10, 361800000), (11, 724080000), (12, 721200000), (13, 343740000), (14, 340670000), (15, 241660000), (16, 315450000), (23, 809910000), (24, 53850000), (25, 124420000), (26, 311430000), (27, 382060000)]),
    (21, &[(1, 934340000), (2, 227440000), (3, 845550000), (4, 469340000), (5, 385400000), (6, 665990000), (7, 38700000), (8, 284250000), (9, 709000000), (10, 674890000), (11, 516910000), (12, 708620000), (13, 200510000), (14, 152740000), (15, 212250000), (16, 444340000), (23, 814840000), (24, 37490000), (25, 306370000), (26, 345320000), (27, 379030000)]),
    (28, &[(1, 874690000), (2, 170440000), (3, 543430000), (4, 312660000), (5, 455590000), (6, 824950000), (7, 38700000), (8, 199380000), (9, 545830000), (10, 531280000), (11, 511670000), (12, 567390000), (13, 335950000), (14, 362160000), (15, 131660000), (16, 360190000), (23, 709910000), (24, 57230000), (25, 297320000), (26, 461480000), (27, 655960000)]),
    (34, &[(7, 38700000)]),
];

const FOOD_MERCHANTS: [u32; 21] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27];

fn at(day: u64, hour: u64) -> u64 {
    T0 + day * DAY + hour * 3600
}

#[test]
fn scenario_programme_cycle() {
    let w = World::new();
    let env = &w.env;

    // 1. 24 legacy merchants enrolled by the agency (M01-M16 food, M17-M22 agri,
    //    M23-M24 both) and 5 self-onboarded (M25-M27 food, M28-M29 agri). M30's licence
    //    is not in the agency registry, so it never gets a record.
    let mut m: std::vec::Vec<Option<Address>> = std::vec![None; 31];
    for i in 1..=24u32 {
        let cats = match i {
            1..=16 => FOOD,
            17..=22 => AGRI,
            _ => FOOD | AGRI,
        };
        m[i as usize] = Some(w.legacy(cats));
    }
    let onboard_day = [(25u32, 3u64), (28, 4), (26, 5), (27, 9), (29, 11)];
    for (i, day) in onboard_day {
        env.ledger().with_mut(|l| l.timestamp = at(day, 10));
        let cats = if i <= 27 { FOOD } else { AGRI };
        m[i as usize] = Some(w.self_onboarded(cats));
        let rec = w.reg.get(m[i as usize].as_ref().unwrap()).unwrap();
        assert!(rec.self_onboarded);
        assert_eq!(rec.activated_at, at(day, 10));
    }
    let m30 = Address::generate(env);
    assert_eq!(w.reg.get(&m30), None);
    assert_eq!(w.reg.count(), 29);
    let mm = |i: u32| m[i as usize].clone().unwrap();

    // 2. Day 1: disbursement to recipients (one aggregate holder stands in for the 391
    //    recipient trustlines) and the 85% float.
    env.ledger().with_mut(|l| l.timestamp = at(1, 6));
    let recipients = Address::generate(env);
    w.credit_vouchers(&recipients, FOOD_DISBURSED);
    w.usac.mint(&w.agency, &(FUND_DAY1 + TOP_UP_DAY30));
    w.c.fund(&w.agency, &FUND_DAY1);
    assert_eq!(w.c.coverage().float, FUND_DAY1);

    let mut received = [0i128; 31];
    let mut queued_ids: std::vec::Vec<(u32, u32)> = std::vec::Vec::new();

    for (round_no, (day, reds)) in ROUNDS.iter().enumerate() {
        // payments during the week, each inside an authorise/pay/de-authorise sandwich
        for (i, bal) in reds.iter() {
            let merchant = mm(*i);
            let new = *bal - w.vtok.balance(&merchant);
            assert!(new >= 0);
            if new > 0 {
                env.ledger().with_mut(|l| l.timestamp = at(*day, 12));
                w.sandwich_pay(&recipients, &merchant, new);
            }
        }
        // 4. M07 is suspended on day 17 (week 3) and reinstated on day 33
        if *day == 21 {
            env.ledger().with_mut(|l| l.timestamp = at(17, 10));
            w.reg.suspend(&mm(7), &17);
        }
        if *day == 34 {
            env.ledger().with_mut(|l| l.timestamp = at(33, 9));
            w.reg.reinstate(&mm(7));
        }
        // 3. weekly redemption round
        env.ledger().with_mut(|l| l.timestamp = at(*day, if *day == 34 { 12 } else { 20 }));
        for (i, bal) in reds.iter() {
            let merchant = mm(*i);
            assert_eq!(w.vtok.balance(&merchant), *bal);
            let r = w.c.try_redeem(&merchant, bal);
            if *i == 7 && (*day == 21 || *day == 28) {
                assert_eq!(r, Err(Ok(Error::MerchantNotActive)), "suspended M07 cannot redeem");
                assert_eq!(w.vtok.balance(&merchant), *bal, "and keeps its vouchers");
                continue;
            }
            match r.unwrap().unwrap() {
                RedeemOutcome::Paid(p) => {
                    assert_eq!(p, *bal);
                    assert!(queued_ids.iter().all(|(_, d)| *d as usize != round_no), "no claim is paid after one queued in the same round");
                    received[*i as usize] += p;
                }
                RedeemOutcome::Queued(id) => {
                    assert_eq!(*day, 28, "only week 4 hits the 85% float");
                    queued_ids.push((*i, round_no as u32));
                    assert_eq!(w.c.claim(&id).unwrap().merchant, merchant);
                }
            }
            assert_eq!(w.vtok.balance(&merchant), 0, "vouchers burned");
            w.assert_invariants();
        }

        if *day == 28 {
            // 5. the week-4 shortfall queued claims, FIFO from the first uncovered one
            let queued: std::vec::Vec<u32> = queued_ids.iter().map(|(i, _)| *i).collect();
            assert_eq!(queued, std::vec![15, 16, 23, 24, 25, 26, 27]);
            let cov = w.c.coverage();
            assert!(cov.queued > 0);
            assert!(cov.float < w.c.claim(&0).unwrap().amount);
            // day 30: top-up to 100% of disbursed, then anyone settles the queue
            env.ledger().with_mut(|l| l.timestamp = at(30, 9));
            w.c.fund(&w.agency, &TOP_UP_DAY30);
            assert_eq!(w.c.settle_queue(&50), 7);
            for (i, _) in queued_ids.iter() {
                received[*i as usize] += reds.iter().find(|(j, _)| j == i).unwrap().1;
            }
            assert_eq!(w.c.coverage().queued, 0);
            w.assert_invariants();
        }
    }

    // every merchant was paid exactly its vouchers, in USDC
    let mut paid_total = 0i128;
    for i in FOOD_MERCHANTS {
        assert_eq!(w.utok.balance(&mm(i)), received[i as usize], "M{i:02}");
        assert_eq!(w.vtok.balance(&mm(i)), 0);
        paid_total += received[i as usize];
    }
    let t = w.totals();
    assert_eq!(t.paid, paid_total);
    assert_eq!(t.clawed, paid_total);
    assert_eq!(t.funded, FOOD_DISBURSED);
    assert_eq!(paid_total, 37_327_100_000, "3,732.71 spent at food merchants");

    // expiry: the agency's classic Clawback of recipient balances (emulated here through
    // the SAC with the admin's authorisation mocked; on testnet it is a classic op)
    env.ledger().with_mut(|l| l.timestamp = at(29, 0) + 60);
    let unspent = w.vtok.balance(&recipients);
    assert_eq!(unspent, FOOD_DISBURSED - paid_total);
    w.vsac.clawback(&recipients, &unspent);
    assert_eq!(w.vtok.balance(&recipients), 0);

    // 6. after the deadline redemption is closed and the surplus goes back to the agency
    env.ledger().with_mut(|l| l.timestamp = REDEEM_DEADLINE + 3600);
    let late = mm(1);
    w.credit_vouchers(&late, 100);
    assert_eq!(w.c.try_redeem(&late, &100), Err(Ok(Error::RedemptionClosed)));
    let surplus = w.c.coverage().float;
    assert_eq!(surplus, unspent, "surplus = unspent share once the float reached 100%");
    let treasury = Address::generate(env);
    w.c.withdraw_surplus(&treasury, &surplus);

    // 7. final invariants and balances
    w.assert_invariants();
    let t = w.totals();
    assert_eq!(t.withdrawn, surplus);
    assert_eq!(w.utok.balance(&w.pool), 0);
    assert_eq!(w.utok.balance(&treasury), 3_522_900_000, "352.29 returned");
    assert_eq!(w.utok.balance(&w.agency), 0);
}
