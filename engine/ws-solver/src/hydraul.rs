// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (hydraul.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! Extended-period hydraulics: initialisation, demands, controls, time steps,
//! tank levels and pump energy (`hydraul.c`).

use crate::Project;
use crate::coeffs::{pcvlosscoeff, resistcoeff};
use crate::error::SolverError;
use crate::input::interp;
use crate::report::{self, Statflag};
use crate::smatrix::createsparse;
use crate::solver::hydsolve;
use crate::types::*;

/// `openhyd`: allocate the solver and set initial link flows.
pub fn openhyd(pr: &mut Project) -> Result<(), SolverError> {
    pr.sm = createsparse(&pr.net);
    let nn = pr.net.nnodes;
    let nl = pr.net.nlinks;
    // Heads, demands, flows, statuses and settings live from `EN_open` on (`allocdata`,
    // see `allochyd`), so a second run starts from the first one's values as EPANET's does.
    allochyd(pr);
    let hyd = &mut pr.hyd;
    hyd.p = vec![0.0; nl + 1];
    hyd.y = vec![0.0; nl + 1];
    hyd.xflow = vec![0.0; nn.max(nl) + 1];
    hyd.old_status = vec![Status::Open; nl + pr.net.ntanks + 1];

    // unlinked: every junction must have at least one link.
    let mut linked = vec![false; nn + 1];
    for k in 1..=nl {
        linked[pr.net.link[k].n1] = true;
        linked[pr.net.link[k].n2] = true;
    }
    if let Some(i) = (1..=pr.net.njuncs).find(|&i| !linked[i]) {
        return Err(SolverError::new(
            233,
            format!("node {} is not connected", pr.net.node[i].id),
        ));
    }
    for i in 1..=nl {
        let (s, kc) = (pr.net.link[i].init_status, pr.net.link[i].kc);
        initlinkflow(pr, i, s, kc);
    }
    Ok(())
}

/// The hydraulic state `allocdata` (project.c) allocates when a project opens, zeroed;
/// kept as is when already allocated.
pub fn allochyd(pr: &mut Project) {
    let nn = pr.net.nnodes;
    let nl = pr.net.nlinks;
    let hyd = &mut pr.hyd;
    if hyd.node_head.len() == nn + 1 && hyd.link_flow.len() == nl + 1 {
        return;
    }
    hyd.node_head = vec![0.0; nn + 1];
    hyd.node_demand = vec![0.0; nn + 1];
    hyd.full_demand = vec![0.0; nn + 1];
    hyd.demand_flow = vec![0.0; nn + 1];
    hyd.emitter_flow = vec![0.0; nn + 1];
    hyd.leakage_flow = vec![0.0; nn + 1];
    hyd.link_flow = vec![0.0; nl + 1];
    hyd.link_setting = vec![0.0; nl + 1];
    // calloc: zero is XHEAD.
    hyd.link_status = vec![Status::XHead; nl + 1];
    pr.qual.node_qual = vec![0.0; nn + 1];
}

/// `inithyd`: initialise tanks, links and flows for a new run.
pub fn inithyd(pr: &mut Project, initflag: bool) {
    let nl = pr.net.nlinks;
    for i in 1..=pr.net.ntanks {
        let tank = &mut pr.net.tank[i];
        tank.v = tank.v0;
        let n = tank.node;
        pr.hyd.node_head[n] = tank.h0;
        pr.hyd.node_demand[n] = 0.0;
        pr.hyd.old_status[nl + i] = Status::TempClosed;
    }
    pr.hyd.demand_flow.fill(0.0);
    pr.hyd.emitter_flow.fill(0.0);
    pr.hyd.leakage_flow.fill(0.0);
    for i in 1..=pr.net.nnodes {
        if pr.net.node[i].ke > 0.0 {
            pr.hyd.emitter_flow[i] = 1.0;
        }
    }
    for i in 1..=nl {
        let link = &pr.net.link[i];
        let lt = link.link_type;
        pr.hyd.link_status[i] = link.init_status;
        pr.hyd.link_setting[i] = link.init_setting;
        if lt > LinkType::Pump && lt != LinkType::Gpv && link.init_status != Status::Active {
            pr.hyd.link_setting[i] = MISSING;
        }
        resistcoeff(pr, i);
        if (lt == LinkType::Prv || lt == LinkType::Psv || lt == LinkType::Fcv)
            && pr.hyd.link_setting[i] != MISSING
        {
            pr.hyd.link_status[i] = Status::Active;
        }
        if pr.hyd.link_status[i] <= Status::Closed {
            pr.hyd.link_flow[i] = QZERO;
        } else if pr.hyd.link_flow[i].abs() <= QZERO || initflag {
            let (s, k) = (pr.hyd.link_status[i], pr.hyd.link_setting[i]);
            initlinkflow(pr, i, s, k);
        }
        pr.hyd.old_status[i] = pr.hyd.link_status[i];
    }
    for i in 1..=pr.net.npumps {
        pr.net.pump[i].energy = Energy::default();
    }
    pr.hyd.flow_balance = FlowBalance::default();
    pr.hyd.haltflag = false;
    pr.times.htime = 0;
    pr.times.hydstep = 0;
    pr.times.rtime = pr.times.rstep;
}

/// `runhyd`: demands and controls at the current time, then solve. Returns the
/// iterations, the relative error and the warning code (`writehydwarn`, 0 if none).
pub fn runhyd(pr: &mut Project) -> Result<(i32, f64, i32), SolverError> {
    demands(pr);
    controls(pr);
    match hydsolve(pr) {
        Ok((iter, relerr)) => {
            if pr.rpt.statflag != Statflag::No && report::writing(pr) {
                report::writehydstat(pr, iter, relerr);
            }
            if relerr > pr.hyd.hacc && pr.hyd.extra_iter == -1 {
                pr.hyd.haltflag = true;
            }
            let warn = report::writehydwarn(pr, iter, relerr);
            Ok((iter, relerr, warn))
        }
        Err((code, _, node)) => Err(SolverError::new(
            code,
            format!(
                "ill-conditioned hydraulic equations at node {} (time {} s)",
                pr.net
                    .node
                    .get(node as usize)
                    .map_or("?", |n| n.id.as_str()),
                pr.times.htime
            ),
        )),
    }
}

/// `nexthyd`: advance to the next hydraulic time. Returns the time step taken
/// (0 when the run is complete).
pub fn nexthyd(pr: &mut Project) -> i64 {
    getallpumpsenergy(pr);
    if pr.hyd.haltflag {
        pr.times.htime = pr.times.dur;
    }
    let mut hydstep = 0;
    if pr.times.htime < pr.times.dur {
        hydstep = timestep(pr);
    }
    if pr.times.dur == 0 {
        addenergy(pr, 0);
    } else if pr.times.htime < pr.times.dur {
        addenergy(pr, hydstep);
    }
    updateflowbalance(pr, hydstep);
    if pr.times.htime < pr.times.dur {
        pr.times.htime += hydstep;
        // A concurrent quality run advances the report time itself.
        if !pr.qual.open_q && pr.times.htime >= pr.times.rtime {
            pr.times.rtime += pr.times.rstep;
        }
    } else {
        endflowbalance(pr);
        if pr.rpt.statflag != Statflag::No && report::writing(pr) {
            report::writeflowbalance(pr);
        }
        pr.times.htime += 1;
        if pr.qual.open_q {
            pr.times.qtime += 1;
        }
    }
    hydstep
}

/// `initlinkflow`
fn initlinkflow(pr: &mut Project, i: usize, s: Status, k: f64) {
    let link = &pr.net.link[i];
    pr.hyd.link_flow[i] = if s == Status::Closed {
        QZERO
    } else if link.link_type == LinkType::Pump {
        k * pr.net.pump[pr.net.findpump(i)].q0
    } else {
        PI * (link.diam * link.diam) / 4.0
    };
}

/// `setlinksetting`: apply a new setting from a pattern, control or rule.
pub fn setlinksetting(pr: &mut Project, index: usize, value: f64) {
    let t = pr.net.link[index].link_type;
    let s = pr.hyd.link_status[index];
    let k = pr.hyd.link_setting[index];
    if t == LinkType::Pump {
        pr.hyd.link_setting[index] = value;
        if value > 0.0 && s <= Status::Closed {
            resetpumpflow(pr, index);
            pr.hyd.link_status[index] = Status::Open;
        }
        if value == 0.0 && s > Status::Closed {
            pr.hyd.link_status[index] = Status::Closed;
        }
    } else if t == LinkType::Fcv {
        pr.hyd.link_setting[index] = value;
        pr.hyd.link_status[index] = Status::Active;
    } else {
        if k == MISSING && s <= Status::Closed {
            pr.hyd.link_status[index] = Status::Open;
        }
        if t == LinkType::Pcv {
            pr.net.link[index].r = pcvlosscoeff(pr, index, value);
        }
        pr.hyd.link_setting[index] = value;
    }
}

/// `setlinkstatus`: open (`value` true) or close a link from a rule.
pub fn setlinkstatus(pr: &mut Project, index: usize, open: bool) {
    let t = pr.net.link[index].link_type;
    if open {
        if t == LinkType::Pump {
            pr.hyd.link_setting[index] = 1.0;
            if pr.hyd.link_status[index] == Status::Closed {
                resetpumpflow(pr, index);
            }
        }
        if t > LinkType::Pump && t != LinkType::Gpv {
            pr.hyd.link_setting[index] = MISSING;
        }
        pr.hyd.link_status[index] = Status::Open;
    } else {
        if t == LinkType::Pump {
            pr.hyd.link_setting[index] = 0.0;
        }
        if t > LinkType::Pump && t != LinkType::Gpv {
            pr.hyd.link_setting[index] = MISSING;
        }
        pr.hyd.link_status[index] = Status::Closed;
    }
}

/// `demands`: demands, reservoir heads and pump speeds from time patterns.
fn demands(pr: &mut Project) {
    let p = (pr.times.htime + pr.times.pstart) / pr.times.pstep;
    pr.hyd.dsystem = 0.0;
    let dmult = pr.hyd.dmult;
    for i in 1..=pr.net.njuncs {
        let mut sum = 0.0;
        for d in &pr.net.node[i].d {
            let mut j = d.pat;
            if j == 0 {
                j = pr.hyd.def_pat;
            }
            let f = &pr.net.pattern[j].f;
            let k = (p % f.len() as i64) as usize;
            let djunc = d.base * f[k] * dmult;
            if djunc > 0.0 {
                pr.hyd.dsystem += djunc;
            }
            sum += djunc;
        }
        pr.hyd.full_demand[i] = sum;
        pr.hyd.demand_flow[i] = sum;
    }
    for n in 1..=pr.net.ntanks {
        let tank = &pr.net.tank[n];
        if tank.a == 0.0 {
            let j = tank.pat;
            if j > 0 {
                let f = &pr.net.pattern[j].f;
                let k = (p % f.len() as i64) as usize;
                let i = tank.node;
                pr.hyd.node_head[i] = pr.net.node[i].el * f[k];
            }
        }
    }
    for n in 1..=pr.net.npumps {
        let j = pr.net.pump[n].upat;
        if j > 0 {
            let i = pr.net.pump[n].link;
            let f = &pr.net.pattern[j].f;
            let k = (p % f.len() as i64) as usize;
            let v = f[k];
            setlinksetting(pr, i, v);
        }
    }
}

/// `controls`: apply simple controls on tank levels and time.
fn controls(pr: &mut Project) -> i32 {
    let mut setsum = 0;
    let njuncs = pr.net.njuncs;
    for i in 1..=pr.net.ncontrols {
        let c = pr.net.control[i].clone();
        if !c.is_enabled {
            continue;
        }
        let k = c.link;
        if k == 0 {
            continue;
        }
        let mut reset = false;
        let n = c.node;
        if n > 0 && n > njuncs {
            let h = pr.hyd.node_head[n];
            let vplus = pr.hyd.node_demand[n].abs();
            let v1 = tankvolume(pr, n - njuncs, h);
            let v2 = tankvolume(pr, n - njuncs, c.grade);
            if c.control_type == ControlType::LowLevel && v1 <= v2 + vplus {
                reset = true;
            }
            if c.control_type == ControlType::HiLevel && v1 >= v2 - vplus {
                reset = true;
            }
        }
        if c.control_type == ControlType::Timer && c.time == pr.times.htime {
            reset = true;
        }
        if c.control_type == ControlType::TimeOfDay
            && (pr.times.htime + pr.times.tstart) % SECPERDAY == c.time
        {
            reset = true;
        }
        if reset {
            let lt = pr.net.link[k].link_type;
            let s1 = if pr.hyd.link_status[k] <= Status::Closed {
                Status::Closed
            } else {
                Status::Open
            };
            let s2 = c.status;
            let k1 = pr.hyd.link_setting[k];
            let mut k2 = k1;
            if lt > LinkType::Pipe {
                k2 = c.setting;
            }
            if lt == LinkType::Pump && s1 == Status::Closed && s2 == Status::Open {
                resetpumpflow(pr, k);
            }
            if s1 != s2 || k1 != k2 {
                pr.hyd.link_status[k] = s2;
                pr.hyd.link_setting[k] = k2;
                if lt == LinkType::Pcv {
                    pr.net.link[k].r = pcvlosscoeff(pr, k, k2);
                }
                if pr.rpt.statflag != Statflag::No && report::writing(pr) {
                    report::writecontrolaction(pr, k, i);
                }
                setsum += 1;
            }
        }
    }
    setsum
}

/// `timestep`: the next hydraulic time step, updating tank levels.
fn timestep(pr: &mut Project) -> i64 {
    let t = &pr.times;
    let mut tstep = t.hstep;
    let n = ((t.htime + t.pstart) / t.pstep) + 1;
    let dt = n * t.pstep - t.htime;
    if dt > 0 && dt < tstep {
        tstep = dt;
    }
    let dt = t.rtime - t.htime;
    if dt > 0 && dt < tstep {
        tstep = dt;
    }
    tanktimestep(pr, &mut tstep);
    controltimestep(pr, &mut tstep);
    if !pr.rules.is_empty() {
        crate::rules::ruletimestep(pr, &mut tstep);
    } else {
        tanklevels(pr, tstep);
    }
    tstep
}

/// `tanktimestep`: shorten the step to the time a tank fills or empties.
pub(crate) fn tanktimestep(pr: &Project, tstep: &mut i64) -> usize {
    let mut tank_idx = 0;
    for i in 1..=pr.net.ntanks {
        let tank = &pr.net.tank[i];
        if tank.a == 0.0 {
            continue;
        }
        let n = tank.node;
        let h = pr.hyd.node_head[n];
        let q = pr.hyd.node_demand[n];
        if q.abs() <= QZERO {
            continue;
        }
        let v = if q > 0.0 && h < tank.hmax {
            tank.vmax - tank.v
        } else if q < 0.0 && h > tank.hmin {
            tank.vmin - tank.v
        } else {
            continue;
        };
        let xt = v / q;
        if xt.abs() > (*tstep + 1) as f64 {
            continue;
        }
        let t = round(xt);
        if t > 0 && t < *tstep {
            *tstep = t;
            tank_idx = n;
        }
    }
    tank_idx
}

/// `controltimestep`: shorten the step to the time a control would act.
pub(crate) fn controltimestep(pr: &Project, tstep: &mut i64) -> usize {
    let mut control_index = 0;
    let njuncs = pr.net.njuncs;
    for i in 1..=pr.net.ncontrols {
        let c = &pr.net.control[i];
        if !c.is_enabled {
            continue;
        }
        let mut t = 0;
        let n = c.node;
        if n > 0 {
            if n <= njuncs {
                continue;
            }
            let j = n - njuncs;
            let h = pr.hyd.node_head[n];
            let q = pr.hyd.node_demand[n];
            if q.abs() <= QZERO {
                continue;
            }
            if (h < c.grade && c.control_type == ControlType::HiLevel && q > 0.0)
                || (h > c.grade && c.control_type == ControlType::LowLevel && q < 0.0)
            {
                let v = tankvolume(pr, j, c.grade) - pr.net.tank[j].v;
                t = round(v / q);
            }
        }
        if c.control_type == ControlType::Timer && c.time > pr.times.htime {
            t = c.time - pr.times.htime;
        }
        if c.control_type == ControlType::TimeOfDay {
            let t1 = (pr.times.htime + pr.times.tstart) % SECPERDAY;
            let t2 = c.time;
            t = if t2 >= t1 {
                t2 - t1
            } else {
                SECPERDAY - t1 + t2
            };
        }
        if t > 0 && t < *tstep {
            let k = c.link;
            let lt = pr.net.link[k].link_type;
            if (lt > LinkType::Pipe && pr.hyd.link_setting[k] != c.setting)
                || pr.hyd.link_status[k] != c.status
            {
                *tstep = t;
                control_index = i;
            }
        }
    }
    control_index
}

/// `addenergy`: accumulate pump energy over a time step.
fn addenergy(pr: &mut Project, hstep: i64) {
    let t = &pr.times;
    let dt = if t.dur == 0 {
        1.0
    } else if t.htime < t.dur {
        hstep as f64 / 3600.0
    } else {
        0.0
    };
    if dt == 0.0 {
        return;
    }
    let n = (t.htime + t.pstart) / t.pstep;
    let c0 = pr.hyd.ecost;
    let mut f0 = 1.0;
    if pr.hyd.epat > 0 {
        let f = &pr.net.pattern[pr.hyd.epat].f;
        f0 = f[(n % f.len() as i64) as usize];
    }
    let mut psum = 0.0;
    for j in 1..=pr.net.npumps {
        let k = pr.net.pump[j].link;
        if pr.net.pump[j].energy.current_effic == 0.0 {
            continue;
        }
        let q = QZERO.max(pr.hyd.link_flow[k].abs());
        let mut c = if pr.net.pump[j].ecost > 0.0 {
            pr.net.pump[j].ecost
        } else {
            c0
        };
        let ep = pr.net.pump[j].epat;
        if ep > 0 {
            let f = &pr.net.pattern[ep].f;
            c *= f[(n % f.len() as i64) as usize];
        } else {
            c *= f0;
        }
        let e = &mut pr.net.pump[j].energy;
        let p = e.current_power;
        let eff = e.current_effic;
        psum += p;
        e.time_on_line += dt;
        e.efficiency += eff * dt;
        e.kw_hrs_per_flow += p / q * dt;
        e.kw_hrs += p * dt;
        e.max_kwatts = e.max_kwatts.max(p);
        e.total_cost += c * p * dt;
    }
    pr.hyd.emax = pr.hyd.emax.max(psum);
}

/// `getenergy`: power (kW) and efficiency of a pump at the current solution.
pub fn getenergy(pr: &Project, k: usize) -> (f64, f64) {
    if pr.hyd.link_status[k] <= Status::Closed {
        return (0.0, 0.0);
    }
    let link = &pr.net.link[k];
    let q = pr.hyd.link_flow[k].abs();
    let dh = (pr.hyd.node_head[link.n1] - pr.hyd.node_head[link.n2]).abs();
    let e = if link.link_type == LinkType::Pump {
        let j = pr.net.findpump(k);
        let mut e = pr.hyd.epump;
        let speed = pr.hyd.link_setting[k];
        let i = pr.net.pump[j].ecurve;
        if i > 0 {
            let q4eff = q / speed * pr.units.ucf[Field::Flow as usize];
            let curve = &pr.net.curve[i];
            e = interp(&curve.x, &curve.y, q4eff);
            e = 100.0 - ((100.0 - e) * pow(1.0 / speed, 0.1));
        }
        e = e.min(100.0);
        e = e.max(1.0);
        e / 100.0
    } else {
        1.0
    };
    let kw = dh * q * pr.hyd.sp_grav / 8.814 / e * KW_PER_HP;
    (kw, e)
}

fn getallpumpsenergy(pr: &mut Project) {
    for j in 1..=pr.net.npumps {
        let k = pr.net.pump[j].link;
        let (kw, eff) = getenergy(pr, k);
        pr.net.pump[j].energy.current_power = kw;
        pr.net.pump[j].energy.current_effic = eff;
    }
}

/// `tanklevels`: update tank volumes and levels over a time step.
pub fn tanklevels(pr: &mut Project, tstep: i64) {
    for i in 1..=pr.net.ntanks {
        if pr.net.tank[i].a == 0.0 {
            continue;
        }
        let n = pr.net.tank[i].node;
        let q = pr.hyd.node_demand[n];
        if q.abs() <= QZERO {
            continue;
        }
        let dv = q * tstep as f64;
        let tank = &mut pr.net.tank[i];
        tank.v += dv;
        if tank.v + q >= tank.vmax {
            tank.v = tank.vmax;
        } else if tank.v - q <= tank.vmin {
            tank.v = tank.vmin;
        }
        let v = tank.v;
        pr.hyd.node_head[n] = tankgrade(pr, i, v);
    }
}

/// `tankvolume`: tank volume at head `h`.
pub fn tankvolume(pr: &Project, i: usize, h: f64) -> f64 {
    let tank = &pr.net.tank[i];
    let j = tank.vcurve;
    if j == 0 {
        return tank.vmin + (h - tank.hmin) * tank.a;
    }
    let curve = &pr.net.curve[j];
    let y = (h - pr.net.node[tank.node].el) * pr.units.ucf[Field::Head as usize];
    interp(&curve.x, &curve.y, y) / pr.units.ucf[Field::Volume as usize]
}

/// `tankgrade`: tank head at volume `v`.
pub fn tankgrade(pr: &Project, i: usize, v: f64) -> f64 {
    let tank = &pr.net.tank[i];
    let j = tank.vcurve;
    if j == 0 {
        return tank.hmin + (v - tank.vmin) / tank.a;
    }
    let curve = &pr.net.curve[j];
    let y = interp(&curve.y, &curve.x, v * pr.units.ucf[Field::Volume as usize]);
    pr.net.node[tank.node].el + y / pr.units.ucf[Field::Head as usize]
}

/// `resetpumpflow`
fn resetpumpflow(pr: &mut Project, i: usize) {
    let p = pr.net.findpump(i);
    if pr.net.pump[p].ptype == PumpType::ConstHp {
        pr.hyd.link_flow[i] = pr.net.pump[p].q0;
    }
}

/// `updateflowbalance` (flowbalance.c)
fn updateflowbalance(pr: &mut Project, hstep: i64) {
    let dt = if pr.times.dur == 0 {
        1.0
    } else if pr.times.htime < pr.times.dur {
        hstep as f64
    } else {
        return;
    };
    let (net, hyd) = (&pr.net, &mut pr.hyd);
    let mut fb = FlowBalance::default();
    hyd.leakage_loss = 0.0;
    for i in 1..=net.njuncs {
        let v = hyd.demand_flow[i];
        if v < 0.0 {
            fb.total_inflow += -v;
        } else {
            fb.consumer_demand += v;
            fb.total_outflow += v;
        }
        let v = hyd.emitter_flow[i];
        fb.emitter_demand += v;
        fb.total_outflow += v;
        let v = hyd.leakage_flow[i];
        fb.leakage_demand += v;
        fb.total_outflow += v;
        if hyd.demand_model == DemandModel::Pda && hyd.full_demand[i] > 0.0 {
            let deficit = hyd.full_demand[i] - hyd.demand_flow[i];
            if deficit > 0.0 {
                fb.deficit_demand += deficit;
            }
        }
    }
    for j in 1..=net.ntanks {
        let i = net.tank[j].node;
        let v = hyd.node_demand[i];
        if net.tank[j].a == 0.0 {
            if v >= 0.0 {
                fb.total_outflow += v;
            } else {
                fb.total_inflow += -v;
            }
        } else {
            fb.storage_demand += v;
        }
    }
    let mut v = fb.total_inflow;
    if fb.storage_demand < 0.0 {
        v += -fb.storage_demand;
    }
    if v > 0.0 {
        hyd.leakage_loss = fb.leakage_demand / v * 100.0;
    }
    let t = &mut hyd.flow_balance;
    t.total_inflow += fb.total_inflow * dt;
    t.total_outflow += fb.total_outflow * dt;
    t.consumer_demand += fb.consumer_demand * dt;
    t.emitter_demand += fb.emitter_demand * dt;
    t.leakage_demand += fb.leakage_demand * dt;
    t.deficit_demand += fb.deficit_demand * dt;
    t.storage_demand += fb.storage_demand * dt;
}

/// `endflowbalance` (flowbalance.c)
fn endflowbalance(pr: &mut Project) {
    let seconds = if pr.times.htime > 0 {
        pr.times.htime as f64
    } else {
        1.0
    };
    let t = &mut pr.hyd.flow_balance;
    t.total_inflow /= seconds;
    t.total_outflow /= seconds;
    t.consumer_demand /= seconds;
    t.emitter_demand /= seconds;
    t.leakage_demand /= seconds;
    t.deficit_demand /= seconds;
    t.storage_demand /= seconds;
    let mut qin = t.total_inflow;
    let mut qout = t.total_outflow;
    let qstor = t.storage_demand;
    if qstor > 0.0 {
        qout += qstor;
    } else {
        qin -= qstor;
    }
    t.ratio = if qin == qout {
        1.0
    } else if qin > 0.0 {
        qout / qin
    } else {
        0.0
    };
}
