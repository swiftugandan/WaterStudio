// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (mathexpr.c). See LICENSES/EPANET-MSX.txt.

//! Symbolic math expressions: a recursive-descent parser that turns a formula into a
//! binary tree and then a postfix list of op codes, and a stack evaluator.
//!
//! Op codes (as in the C source): 1 `(`, 2 `)`, 3 `+`, 4 `-`, 5 `*`, 6 `/`, 7 number,
//! 8 variable, 9 unary minus, 10..28 functions (`cos` ... `step`), 31 `^`.

use crate::fp::{exp, log, log10, pow};

const MAX_STACK_SIZE: usize = 1024;

const MATH_FUNC: [&str; 19] = [
    "COS", "SIN", "TAN", "COT", "ABS", "SGN", "SQRT", "LOG", "EXP", "ASIN", "ACOS", "ATAN", "ACOT",
    "SINH", "COSH", "TANH", "COTH", "LOG10", "STEP",
];

/// One entry of a postfix expression.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ExprNode {
    opcode: i32,
    ivar: i32,
    fvalue: f64,
}

/// A tokenized math expression in postfix order (`MathExpr`).
#[derive(Clone, Debug, PartialEq)]
pub struct MathExpr {
    nodes: Vec<ExprNode>,
    /// The deepest the evaluation stack gets, so evaluation can use a small array.
    depth: usize,
}

/// Evaluation stacks up to this size live on the machine stack.
const SMALL_STACK: usize = 32;

/// Supplies the value of the variable with a given index during evaluation.
pub trait Vars {
    fn value(&mut self, ivar: i32) -> f64;
}

struct Tree {
    opcode: i32,
    ivar: i32,
    fvalue: f64,
    left: Option<Box<Tree>>,
    right: Option<Box<Tree>>,
}

fn new_node() -> Box<Tree> {
    Box::new(Tree {
        opcode: 0,
        ivar: -1,
        fvalue: 0.0,
        left: None,
        right: None,
    })
}

/// `sametext`: case-insensitive comparison.
fn sametext(s1: &str, s2: &str) -> bool {
    s1.eq_ignore_ascii_case(s2)
}

fn is_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

fn is_letter(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

/// `atof` on a string built only from digits, '.', 'E' and a sign.
fn atof(s: &str) -> f64 {
    // The C code only builds well-formed numbers or a lone "." (which atof reads as 0).
    s.parse::<f64>().unwrap_or(0.0)
}

struct Parser<'a> {
    err: i32,
    bc: i32,
    prev_lex: i32,
    cur_lex: i32,
    len: i32,
    pos: i32,
    s: &'a [u8],
    token: String,
    ivar: i32,
    fvalue: f64,
    get_var: &'a dyn Fn(&str) -> i32,
}

impl Parser<'_> {
    /// `S[Pos]`, with the C string's terminating NUL past the end.
    fn at(&self, pos: i32) -> u8 {
        if pos < 0 {
            return 0;
        }
        self.s.get(pos as usize).copied().unwrap_or(0)
    }

    fn get_token(&mut self) {
        self.token.clear();
        while self.pos <= self.len && (is_letter(self.at(self.pos)) || is_digit(self.at(self.pos)))
        {
            self.token.push(self.at(self.pos) as char);
            self.pos += 1;
        }
        self.pos -= 1;
    }

    fn get_math_func(&self) -> i32 {
        for (i, f) in MATH_FUNC.iter().enumerate() {
            if sametext(f, &self.token) {
                return i as i32 + 10;
            }
        }
        0
    }

    fn get_variable(&mut self) -> i32 {
        self.ivar = (self.get_var)(&self.token);
        if self.ivar >= 0 { 8 } else { 0 }
    }

    fn get_number(&mut self) -> f64 {
        let mut s = String::new();
        let mut errflag = false;
        // --- whole number portion
        while self.pos < self.len && is_digit(self.at(self.pos)) {
            s.push(self.at(self.pos) as char);
            self.pos += 1;
        }
        // --- fractional portion
        if self.pos < self.len {
            if self.at(self.pos) == b'.' {
                s.push('.');
                self.pos += 1;
                while self.pos < self.len && is_digit(self.at(self.pos)) {
                    s.push(self.at(self.pos) as char);
                    self.pos += 1;
                }
            }
            // --- exponent
            if self.pos < self.len && (self.at(self.pos) == b'e' || self.at(self.pos) == b'E') {
                s.push('E');
                self.pos += 1;
                if self.pos >= self.len {
                    errflag = true;
                } else {
                    if self.at(self.pos) == b'-' || self.at(self.pos) == b'+' {
                        s.push(self.at(self.pos) as char);
                        self.pos += 1;
                    }
                    if self.pos >= self.len || !is_digit(self.at(self.pos)) {
                        errflag = true;
                    } else {
                        while self.pos < self.len && is_digit(self.at(self.pos)) {
                            s.push(self.at(self.pos) as char);
                            self.pos += 1;
                        }
                    }
                }
            }
        }
        self.pos -= 1;
        if errflag { 0.0 } else { atof(&s) }
    }

    fn get_operand(&mut self) -> i32 {
        match self.at(self.pos) {
            b'(' => 1,
            b')' => 2,
            b'+' => 3,
            b'-' => {
                if self.pos < self.len - 1
                    && is_digit(self.at(self.pos + 1))
                    && (self.cur_lex <= 6 || self.cur_lex == 31)
                {
                    self.pos += 1;
                    self.fvalue = -self.get_number();
                    7
                } else {
                    4
                }
            }
            b'*' => 5,
            b'/' => 6,
            b'^' => 31,
            _ => 0,
        }
    }

    fn get_lex(&mut self) -> i32 {
        while self.pos < self.len && self.at(self.pos) == b' ' {
            self.pos += 1;
        }
        if self.pos >= self.len {
            return 0;
        }
        let mut n = self.get_operand();
        if n == 0 {
            let c = self.at(self.pos);
            if is_letter(c) {
                self.get_token();
                n = self.get_math_func();
                if n == 0 {
                    n = self.get_variable();
                }
            } else if c == b'.' || is_digit(c) {
                n = 7;
                self.fvalue = self.get_number();
            }
        }
        self.pos += 1;
        self.prev_lex = self.cur_lex;
        self.cur_lex = n;
        n
    }

    fn get_single_op(&mut self, lex: &mut i32) -> Option<Box<Tree>> {
        let mut left;
        if *lex == 1 {
            // --- open parenthesis, so continue to grow the tree
            self.bc += 1;
            left = self.get_tree();
        } else {
            // --- error if not a singleton operand
            if *lex < 7 || *lex == 9 || *lex > 30 {
                self.err = 1;
                return None;
            }
            let opcode = *lex;
            if *lex == 7 || *lex == 8 {
                // --- simple number or variable name
                let mut node = new_node();
                node.opcode = opcode;
                if *lex == 7 {
                    node.fvalue = self.fvalue;
                }
                if *lex == 8 {
                    node.ivar = self.ivar;
                }
                left = Some(node);
            } else {
                // --- function which must have a '(' after it
                *lex = self.get_lex();
                if *lex != 1 {
                    self.err = 1;
                    return None;
                }
                self.bc += 1;
                let mut node = new_node();
                node.left = self.get_tree();
                node.opcode = opcode;
                left = Some(node);
            }
        }
        *lex = self.get_lex();

        // --- exponentiation
        if *lex == 31 {
            let mut node = new_node();
            node.left = left;
            node.opcode = *lex;
            *lex = self.get_lex();
            node.right = self.get_single_op(lex);
            left = Some(node);
        }
        left
    }

    fn get_op(&mut self, lex: &mut i32) -> Option<Box<Tree>> {
        let mut neg = false;
        *lex = self.get_lex();
        if self.prev_lex == 0 || self.prev_lex == 1 {
            if *lex == 4 {
                neg = true;
                *lex = self.get_lex();
            } else if *lex == 3 {
                *lex = self.get_lex();
            }
        }
        let mut left = self.get_single_op(lex);
        while *lex == 5 || *lex == 6 {
            let opcode = *lex;
            *lex = self.get_lex();
            let right = self.get_single_op(lex);
            let mut node = new_node();
            if self.err != 0 {
                return None;
            }
            node.left = left;
            node.right = right;
            node.opcode = opcode;
            left = Some(node);
        }
        if neg {
            let mut node = new_node();
            if self.err != 0 {
                return None;
            }
            node.left = left;
            node.right = None;
            node.opcode = 9;
            left = Some(node);
        }
        left
    }

    fn get_tree(&mut self) -> Option<Box<Tree>> {
        let mut lex = 0;
        let mut left = self.get_op(&mut lex);
        loop {
            if lex == 0 || lex == 2 {
                if lex == 2 {
                    self.bc -= 1;
                }
                break;
            }
            if lex != 3 && lex != 4 {
                self.err = 1;
                break;
            }
            let opcode = lex;
            let right = self.get_op(&mut lex);
            let mut node = new_node();
            if self.err != 0 {
                break;
            }
            node.left = left;
            node.right = right;
            node.opcode = opcode;
            left = Some(node);
        }
        left
    }
}

/// `traverseTree`: binary tree to postfix list.
fn traverse(tree: &Option<Box<Tree>>, out: &mut Vec<ExprNode>) {
    let Some(t) = tree else { return };
    traverse(&t.left, out);
    traverse(&t.right, out);
    out.push(ExprNode {
        opcode: t.opcode,
        ivar: t.ivar,
        fvalue: t.fvalue,
    });
}

impl MathExpr {
    /// `mathexpr_create`: parse `formula`, resolving names with `get_var` (a negative
    /// result means the name is unknown). `None` if the formula is not valid.
    pub fn create(formula: &str, get_var: &dyn Fn(&str) -> i32) -> Option<MathExpr> {
        let s = formula.as_bytes();
        let mut p = Parser {
            err: 0,
            bc: 0,
            prev_lex: 0,
            cur_lex: 0,
            len: s.len() as i32,
            pos: 0,
            s,
            token: String::new(),
            ivar: 0,
            fvalue: 0.0,
            get_var,
        };
        let tree = p.get_tree();
        if p.bc == 0 && p.err == 0 {
            let mut nodes = Vec::new();
            traverse(&tree, &mut nodes);
            if nodes.is_empty() {
                return None;
            }
            let mut si: isize = 0;
            let mut depth = 0isize;
            for n in &nodes {
                match n.opcode {
                    3..=6 | 31 => si -= 1,
                    7 | 8 => si += 1,
                    _ => {}
                }
                depth = depth.max(si);
            }
            let depth = depth.max(0) as usize;
            if depth >= MAX_STACK_SIZE {
                return None;
            }
            Some(MathExpr { nodes, depth })
        } else {
            None
        }
    }

    /// `mathexpr_eval`: evaluate with a stack; an illegal operation (NaN) gives 0.
    pub fn eval<V: Vars + ?Sized>(&self, vars: &mut V) -> f64 {
        if self.depth < SMALL_STACK {
            let mut st = [0.0f64; SMALL_STACK];
            self.eval_on(&mut st, vars)
        } else {
            let mut st = vec![0.0f64; self.depth + 1];
            self.eval_on(&mut st, vars)
        }
    }

    fn eval_on<V: Vars + ?Sized>(&self, st: &mut [f64], vars: &mut V) -> f64 {
        let mut si: isize = 0;
        for node in &self.nodes {
            let i = si as usize;
            match node.opcode {
                3 => {
                    let r1 = st[i];
                    si -= 1;
                    let r2 = st[i - 1];
                    st[i - 1] = r2 + r1;
                }
                4 => {
                    let r1 = st[i];
                    si -= 1;
                    let r2 = st[i - 1];
                    st[i - 1] = r2 - r1;
                }
                5 => {
                    let r1 = st[i];
                    si -= 1;
                    let r2 = st[i - 1];
                    st[i - 1] = r2 * r1;
                }
                6 => {
                    let r1 = st[i];
                    si -= 1;
                    let r2 = st[i - 1];
                    st[i - 1] = r2 / r1;
                }
                7 => {
                    si += 1;
                    st[si as usize] = node.fvalue;
                }
                8 => {
                    let r1 = vars.value(node.ivar);
                    si += 1;
                    st[si as usize] = r1;
                }
                9 => st[i] = -st[i],
                10 => st[i] = st[i].cos(),
                11 => st[i] = st[i].sin(),
                12 => st[i] = st[i].tan(),
                13 => st[i] = 1.0 / st[i].tan(),
                14 => st[i] = st[i].abs(),
                15 => {
                    let r1 = st[i];
                    st[i] = if r1 < 0.0 {
                        -1.0
                    } else if r1 > 0.0 {
                        1.0
                    } else {
                        0.0
                    };
                }
                16 => st[i] = st[i].sqrt(),
                17 => st[i] = log(st[i]),
                18 => st[i] = exp(st[i]),
                19 => st[i] = st[i].asin(),
                20 => st[i] = st[i].acos(),
                21 => st[i] = st[i].atan(),
                22 => st[i] = 1.570_796_326_794_896_6 - st[i].atan(),
                23 => {
                    let r1 = st[i];
                    st[i] = (exp(r1) - exp(-r1)) / 2.0;
                }
                24 => {
                    let r1 = st[i];
                    st[i] = (exp(r1) + exp(-r1)) / 2.0;
                }
                25 => {
                    let r1 = st[i];
                    st[i] = (exp(r1) - exp(-r1)) / (exp(r1) + exp(-r1));
                }
                26 => {
                    let r1 = st[i];
                    st[i] = (exp(r1) + exp(-r1)) / (exp(r1) - exp(-r1));
                }
                27 => st[i] = log10(st[i]),
                28 => st[i] = if st[i] <= 0.0 { 0.0 } else { 1.0 },
                31 => {
                    let r1 = st[i];
                    si -= 1;
                    if si < 0 {
                        continue;
                    }
                    let r2 = st[i - 1];
                    st[i - 1] = if r2 <= 0.0 { 0.0 } else { pow(r2, r1) };
                }
                _ => {}
            }
        }
        let r1 = if si >= 0 { st[si as usize] } else { 0.0 };
        // An illegal math operation gives NaN; report it as 0.
        if r1.is_nan() { 0.0 } else { r1 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct V(Vec<f64>);
    impl Vars for V {
        fn value(&mut self, i: i32) -> f64 {
            self.0[i as usize]
        }
    }

    fn names(s: &str) -> i32 {
        match s {
            "a" => 1,
            "b" => 2,
            "AS3" => 3,
            _ => -1,
        }
    }

    fn ev(s: &str) -> Option<f64> {
        MathExpr::create(s, &names).map(|e| e.eval(&mut V(vec![0.0, 2.0, 3.0, 10.0])))
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(ev("1+2*3"), Some(7.0));
        assert_eq!(ev("(1+2)*3"), Some(9.0));
        assert_eq!(ev("a*b-AS3"), Some(-4.0));
        assert_eq!(ev("2^3"), Some(8.0));
        assert_eq!(ev("1.5e2/3"), Some(50.0));
        assert_eq!(ev(".5*4"), Some(2.0));
    }

    #[test]
    fn unary_minus_applies_to_the_whole_product() {
        // The C parser negates the full product term: -a*b = -(a*b).
        assert_eq!(ev("-a*b"), Some(-6.0));
        assert_eq!(ev("-a+b"), Some(1.0));
        // '-' before a digit after an operator is a negative literal.
        assert_eq!(ev("a*-2"), Some(-4.0));
        // At the start a leading "-2" is a literal, and a negative base to a power is 0.
        assert_eq!(ev("-2^2"), Some(0.0));
    }

    #[test]
    fn functions_and_their_edge_cases() {
        assert_eq!(ev("abs(-3)"), Some(3.0));
        assert_eq!(ev("SGN(0)"), Some(0.0));
        assert_eq!(ev("step(a-2)"), Some(0.0));
        assert_eq!(ev("STEP(a)"), Some(1.0));
        assert_eq!(ev("log10(100)"), Some(2.0));
        assert_eq!(ev("exp(0)"), Some(1.0));
        // A non-positive base to a power gives 0, and NaN gives 0.
        assert_eq!(ev("(0-2)^0.5"), Some(0.0));
        assert_eq!(ev("sqrt(0-1)"), Some(0.0));
    }

    #[test]
    fn invalid_formulas() {
        assert_eq!(ev("(1+2"), None);
        assert_eq!(ev("1+"), None);
        assert_eq!(ev("unknown*2"), None);
        assert_eq!(ev("cos 2"), None);
        assert_eq!(ev(""), None);
    }
}
