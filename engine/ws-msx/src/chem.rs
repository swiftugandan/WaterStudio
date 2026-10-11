// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxchem.c, msxerr.c). See LICENSES/EPANET-MSX.txt.

//! Chemistry: which species follow rate, equilibrium or formula expressions, how
//! variables are looked up while an expression is evaluated, and the equilibrium
//! solve for a pipe segment or a tank. The reaction loops over segments live in
//! [`crate::qual`], which owns the segments.
//!
//! The C code shares one concentration vector (`ChemC1`) between the integrators,
//! the equilibrium solver and expression evaluation; [`Vars::c1`] plays that role,
//! and its side effects are kept.

use crate::expr::{MathExpr, Vars as ExprVars};
use crate::solvers::{Newton, Rk5, Ros2, System};
use crate::types::*;

/// Maximum Newton iterations and significant digits for equilibrium solves.
pub const MAXIT: i32 = 20;
pub const NUMSIG: i32 = 3;

/// The species governed by each kind of expression (`setSpeciesChemistry`).
#[derive(Clone, Debug, Default)]
pub struct Lists {
    pub nsp: usize,
    pub pipe_rate: Vec<usize>,
    pub tank_rate: Vec<usize>,
    pub pipe_equil: Vec<usize>,
    pub tank_equil: Vec<usize>,
    pub n_pipe_rate: usize,
    pub n_tank_rate: usize,
    pub n_pipe_formula: usize,
    pub n_tank_formula: usize,
    pub n_pipe_equil: usize,
    pub n_tank_equil: usize,
    pub last_index: [usize; MAX_OBJECTS],
}

/// The math error flag of msxerr.c: only the first illegal operation is reported.
#[derive(Clone, Debug, Default)]
pub struct MathError {
    pub flag: bool,
    pub msg: String,
}

/// State that expression evaluation reads and the solvers' callbacks write.
#[derive(Clone, Debug, Default)]
pub struct Vars {
    /// `ChemC1`: the concentrations expressions see.
    pub c1: Vec<f64>,
    pub hydvar: [f64; MAX_HYD_VARS],
    pub the_link: usize,
    pub the_node: usize,
    pub the_tank: usize,
    pub math: MathError,
}

/// Workspace of the equilibrium solve.
#[derive(Clone, Debug, Default)]
pub struct Equil {
    pub yequil: Vec<f64>,
    pub newton: Newton,
    scratch: Vec<f64>,
}

/// The chemistry system (`MSXchem_open`).
#[derive(Clone, Debug, Default)]
pub struct Chem {
    pub lists: Lists,
    pub vars: Vars,
    pub equil: Equil,
    pub yrate: Vec<f64>,
    pub ytmp: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: Vec<f64>,
    pub rk5: Option<Rk5>,
    pub ros2: Option<Ros2>,
}

/// `MSXerr_validate`: a NaN becomes 0 and raises the math error flag.
fn validate(
    m: &Model,
    math: &mut MathError,
    x: f64,
    index: usize,
    element: usize,
    expr_type: i32,
) -> f64 {
    if !x.is_nan() {
        return x;
    }
    if math.flag {
        return 0.0;
    }
    math.msg = if expr_type == TERM as i32 {
        format!(
            "Ilegal math operation occurred for term:\n  {}",
            m.terms.get(index).map(|t| t.id.as_str()).unwrap_or("")
        )
    } else {
        let element = ["", "pipe", "tank"].get(element).copied().unwrap_or("");
        let kind = ["", "rate", "formula", "equilibrium"]
            .get(expr_type as usize)
            .copied()
            .unwrap_or("");
        format!(
            "Ilegal math operation occurred in {element} {kind} expression for species:\n  {}",
            m.species.get(index).map(|s| s.id.as_str()).unwrap_or("")
        )
    };
    math.flag = true;
    0.0
}

fn eval_opt<V: ExprVars>(e: &Option<MathExpr>, v: &mut V) -> f64 {
    match e {
        Some(e) => e.eval(v),
        None => 0.0,
    }
}

/// Variable lookup for a pipe (`getPipeVariableValue`).
struct PipeVars<'a> {
    m: &'a Model,
    l: &'a Lists,
    c1: &'a [f64],
    hydvar: &'a [f64; MAX_HYD_VARS],
    link: usize,
    math: &'a mut MathError,
}

impl ExprVars for PipeVars<'_> {
    fn value(&mut self, i: i32) -> f64 {
        let m = self.m;
        let last = &self.l.last_index;
        let mut i = i.max(0) as usize;
        if i <= last[SPECIES] {
            let s = &m.species[i];
            if s.pipe_expr_type == FORMULA {
                let x = eval_opt(&s.pipe_expr, self);
                validate(m, self.math, x, i, LINK, FORMULA)
            } else {
                self.c1[i]
            }
        } else if i <= last[TERM] {
            i -= last[TERM - 1];
            let x = eval_opt(&m.terms[i].expr, self);
            validate(m, self.math, x, i, 0, TERM as i32)
        } else if i <= last[PARAMETER] {
            i -= last[PARAMETER - 1];
            m.links[self.link].param[i]
        } else if i <= last[CONSTANT] {
            i -= last[CONSTANT - 1];
            m.consts[i].value
        } else {
            i -= last[CONSTANT];
            if i < MAX_HYD_VARS {
                self.hydvar[i]
            } else {
                0.0
            }
        }
    }
}

/// Variable lookup for a tank (`getTankVariableValue`).
struct TankVars<'a> {
    m: &'a Model,
    l: &'a Lists,
    c1: &'a [f64],
    node: usize,
    math: &'a mut MathError,
}

impl ExprVars for TankVars<'_> {
    fn value(&mut self, i: i32) -> f64 {
        let m = self.m;
        let last = &self.l.last_index;
        let mut i = i.max(0) as usize;
        if i <= last[SPECIES] {
            let s = &m.species[i];
            if s.tank_expr_type == FORMULA {
                let x = eval_opt(&s.tank_expr, self);
                validate(m, self.math, x, i, TANK, FORMULA)
            } else {
                self.c1[i]
            }
        } else if i <= last[TERM] {
            i -= last[TERM - 1];
            let x = eval_opt(&m.terms[i].expr, self);
            validate(m, self.math, x, i, 0, TERM as i32)
        } else if i <= last[PARAMETER] {
            i -= last[PARAMETER - 1];
            let j = m.nodes[self.node].tank;
            if j > 0 { m.tanks[j].param[i] } else { 0.0 }
        } else if i <= last[CONSTANT] {
            i -= last[CONSTANT - 1];
            m.consts[i].value
        } else {
            0.0
        }
    }
}

impl Vars {
    fn pipe<'a>(&'a mut self, m: &'a Model, l: &'a Lists) -> PipeVars<'a> {
        PipeVars {
            m,
            l,
            c1: &self.c1,
            hydvar: &self.hydvar,
            link: self.the_link,
            math: &mut self.math,
        }
    }

    fn tank<'a>(&'a mut self, m: &'a Model, l: &'a Lists) -> TankVars<'a> {
        TankVars {
            m,
            l,
            c1: &self.c1,
            node: self.the_node,
            math: &mut self.math,
        }
    }
}

/// `getPipeEquil` / `getTankEquil`.
struct EquilSystem<'a> {
    m: &'a Model,
    l: &'a Lists,
    vars: &'a mut Vars,
    tank: bool,
}

impl System for EquilSystem<'_> {
    fn eval(&mut self, _t: f64, y: &[f64], n: usize, f: &mut [f64]) {
        let (m, l) = (self.m, self.l);
        let species = if self.tank {
            &l.tank_equil
        } else {
            &l.pipe_equil
        };
        for i in 1..=n {
            self.vars.c1[species[i]] = y[i];
        }
        for i in 1..=n {
            let sp = species[i];
            let (x, element) = if self.tank {
                (
                    eval_opt(&m.species[sp].tank_expr, &mut self.vars.tank(m, l)),
                    TANK,
                )
            } else {
                (
                    eval_opt(&m.species[sp].pipe_expr, &mut self.vars.pipe(m, l)),
                    LINK,
                )
            };
            f[i] = validate(m, &mut self.vars.math, x, sp, element, EQUIL);
        }
    }
}

/// `evalPipeEquil` / `evalTankEquil`.
fn eval_equil(
    m: &Model,
    l: &Lists,
    vars: &mut Vars,
    eq: &mut Equil,
    tank: bool,
    c: &mut [f64],
) -> i32 {
    let nsp = l.nsp;
    vars.c1[1..=nsp].copy_from_slice(&c[1..=nsp]);
    let (species, n) = if tank {
        (&l.tank_equil, l.n_tank_equil)
    } else {
        (&l.pipe_equil, l.n_pipe_equil)
    };
    for i in 1..=n {
        eq.yequil[i] = c[species[i]];
    }
    let mut sys = EquilSystem { m, l, vars, tank };
    let err = eq.newton.solve(&mut eq.yequil, n, MAXIT, NUMSIG, &mut sys);
    if err < 0 {
        return ERR_NEWTON;
    }
    for i in 1..=n {
        let sp = species[i];
        c[sp] = eq.yequil[i];
        vars.c1[sp] = c[sp];
    }
    0
}

/// `evalPipeFormulas` / `evalTankFormulas`.
fn eval_formulas(m: &Model, l: &Lists, vars: &mut Vars, tank: bool, c: &mut [f64]) {
    let nsp = l.nsp;
    vars.c1[1..=nsp].copy_from_slice(&c[1..=nsp]);
    for sp in 1..=nsp {
        let s = &m.species[sp];
        if tank {
            if s.tank_expr_type == FORMULA {
                let x = eval_opt(&s.tank_expr, &mut vars.tank(m, l));
                c[sp] = validate(m, &mut vars.math, x, sp, TANK, FORMULA);
            }
        } else if s.pipe_expr_type == FORMULA {
            let x = eval_opt(&s.pipe_expr, &mut vars.pipe(m, l));
            c[sp] = validate(m, &mut vars.math, x, sp, LINK, FORMULA);
        }
    }
}

/// The body of `MSXchem_equil` once the zone's variables are set.
fn equil_body(
    m: &Model,
    l: &Lists,
    vars: &mut Vars,
    eq: &mut Equil,
    tank: bool,
    c: &mut [f64],
) -> i32 {
    let mut err = 0;
    let n = if tank { l.n_tank_equil } else { l.n_pipe_equil };
    if n > 0 {
        err = eval_equil(m, l, vars, eq, tank, c);
    }
    eval_formulas(m, l, vars, tank, c);
    err
}

/// `MSXchem_equil` applied to `ChemC1` itself.
fn equil_on_c1(m: &Model, l: &Lists, vars: &mut Vars, eq: &mut Equil, tank: bool) -> i32 {
    let mut c = std::mem::take(&mut eq.scratch);
    c.clear();
    c.extend_from_slice(&vars.c1);
    let err = equil_body(m, l, vars, eq, tank, &mut c);
    vars.c1.copy_from_slice(&c);
    eq.scratch = c;
    err
}

/// `getPipeDcDt` / `getTankDcDt`.
pub struct Rates<'a> {
    pub m: &'a Model,
    pub l: &'a Lists,
    pub vars: &'a mut Vars,
    pub eq: &'a mut Equil,
    pub tank: bool,
}

impl System for Rates<'_> {
    fn eval(&mut self, _t: f64, y: &[f64], n: usize, deriv: &mut [f64]) {
        let (m, l) = (self.m, self.l);
        let species = if self.tank {
            &l.tank_rate
        } else {
            &l.pipe_rate
        };
        for i in 1..=n {
            self.vars.c1[species[i]] = y[i];
        }
        if m.coupling == FULL_COUPLING && equil_on_c1(m, l, self.vars, self.eq, self.tank) > 0 {
            for d in &mut deriv[1..=n] {
                *d = 0.0;
            }
            return;
        }
        for i in 1..=n {
            let sp = species[i];
            let (x, element) = if self.tank {
                (
                    eval_opt(&m.species[sp].tank_expr, &mut self.vars.tank(m, l)),
                    TANK,
                )
            } else {
                (
                    eval_opt(&m.species[sp].pipe_expr, &mut self.vars.pipe(m, l)),
                    LINK,
                )
            };
            deriv[i] = validate(m, &mut self.vars.math, x, sp, element, RATE);
        }
    }
}

impl Chem {
    /// `MSXchem_open`. Copies pipe chemistry to tanks when no tank chemistry was
    /// given, as the C code does.
    pub fn open(model: &mut Model) -> Result<Chem, i32> {
        let nsp = model.nsp();
        let n1 = nsp + 1;
        let mut l = Lists {
            nsp,
            pipe_rate: vec![0; n1],
            tank_rate: vec![0; n1],
            pipe_equil: vec![0; n1],
            tank_equil: vec![0; n1],
            ..Lists::default()
        };
        // setSpeciesChemistry
        for sp in 1..=nsp {
            let s = &model.species[sp];
            match s.pipe_expr_type {
                RATE => {
                    l.n_pipe_rate += 1;
                    l.pipe_rate[l.n_pipe_rate] = sp;
                }
                FORMULA => l.n_pipe_formula += 1,
                EQUIL => {
                    l.n_pipe_equil += 1;
                    l.pipe_equil[l.n_pipe_equil] = sp;
                }
                _ => {}
            }
            match s.tank_expr_type {
                RATE => {
                    l.n_tank_rate += 1;
                    l.tank_rate[l.n_tank_rate] = sp;
                }
                FORMULA => l.n_tank_formula += 1,
                EQUIL => {
                    l.n_tank_equil += 1;
                    l.tank_equil[l.n_tank_equil] = sp;
                }
                _ => {}
            }
        }
        let num_pipe_expr = l.n_pipe_rate + l.n_pipe_formula + l.n_pipe_equil;
        let mut num_tank_expr = l.n_tank_rate + l.n_tank_formula + l.n_tank_equil;

        // setTankChemistry
        if num_tank_expr == 0 {
            for s in &mut model.species[1..] {
                s.tank_expr = s.pipe_expr.clone();
                s.tank_expr_type = s.pipe_expr_type;
            }
            l.n_tank_rate = l.n_pipe_rate;
            l.tank_rate = l.pipe_rate.clone();
            l.n_tank_formula = l.n_pipe_formula;
            l.n_tank_equil = l.n_pipe_equil;
            l.tank_equil = l.pipe_equil.clone();
            num_tank_expr = num_pipe_expr;
        }

        let num_bulk = model.species[1..].iter().filter(|s| s.kind == BULK).count();
        if num_pipe_expr != nsp {
            return Err(ERR_NUM_PIPE_EXPR);
        }
        if num_tank_expr != num_bulk {
            return Err(ERR_NUM_TANK_EXPR);
        }

        let rk5 = (model.solver == RK5).then(|| Rk5::new(nsp, 1000, true));
        let ros2 = (model.solver == ROS2).then(|| Ros2::new(nsp, true));
        let neq = l.n_pipe_equil.max(l.n_tank_equil);

        let n = &model.nobjects;
        l.last_index[SPECIES] = n[SPECIES];
        l.last_index[TERM] = l.last_index[SPECIES] + n[TERM];
        l.last_index[PARAMETER] = l.last_index[TERM] + n[PARAMETER];
        l.last_index[CONSTANT] = l.last_index[PARAMETER] + n[CONSTANT];

        Ok(Chem {
            lists: l,
            vars: Vars {
                c1: vec![0.0; n1],
                ..Vars::default()
            },
            equil: Equil {
                yequil: vec![0.0; n1],
                newton: Newton::new(neq),
                scratch: Vec::with_capacity(n1),
            },
            yrate: vec![0.0; n1],
            ytmp: vec![0.0; n1],
            atol: vec![0.0; n1],
            rtol: vec![0.0; n1],
            rk5,
            ros2,
        })
    }

    /// `MSXchem_equil(LINK, k, c)`: `hydvar` is the link's hydraulic variables.
    pub fn equil_link(
        &mut self,
        m: &Model,
        k: usize,
        hydvar: &[f64; MAX_HYD_VARS],
        c: &mut [f64],
    ) -> i32 {
        self.vars.the_link = k;
        self.vars.hydvar[1..].copy_from_slice(&hydvar[1..]);
        equil_body(m, &self.lists, &mut self.vars, &mut self.equil, false, c)
    }

    /// `MSXchem_equil(NODE, k, c)` for tank `k` (0 for a junction or reservoir).
    pub fn equil_node(&mut self, m: &Model, k: usize, c: &mut [f64]) -> i32 {
        self.vars.the_tank = k;
        self.vars.the_node = m.tanks[k].node;
        equil_body(m, &self.lists, &mut self.vars, &mut self.equil, true, c)
    }
}
