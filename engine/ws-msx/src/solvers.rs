// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxutils.c, newton.c, rk5.c, ros2.c). See LICENSES/EPANET-MSX.txt.

//! The numerical solvers behind the chemistry: LU factorization with partial pivoting,
//! a finite-difference Jacobian, Newton-Raphson for equilibrium equations, the
//! Dormand-Prince RK5(4) integrator and the ROS2 Rosenbrock integrator. Arrays are
//! 1-based as in the C code.

use crate::fp::pow;

const TINY1: f64 = 1.0e-20;

/// The right-hand side of a system: `f = F(t, y)` for the first `n` entries.
pub trait System {
    fn eval(&mut self, t: f64, y: &[f64], n: usize, f: &mut [f64]);
}

/// A square matrix with 1-based indexing, sized `(n + 1) x (n + 1)`.
#[derive(Clone, Debug, Default)]
pub struct Matrix {
    stride: usize,
    a: Vec<f64>,
}

impl Matrix {
    pub fn new(n1: usize) -> Matrix {
        Matrix {
            stride: n1,
            a: vec![0.0; n1 * n1],
        }
    }

    #[inline(always)]
    fn at(&self, i: usize, j: usize) -> f64 {
        self.a[i * self.stride + j]
    }

    #[inline(always)]
    fn set(&mut self, i: usize, j: usize, v: f64) {
        self.a[i * self.stride + j] = v;
    }
}

/// `factorize`: LU decomposition with implicit scaling (Crout). `false` if singular.
pub fn factorize(a: &mut Matrix, n: usize, w: &mut [f64], indx: &mut [usize]) -> bool {
    for i in 1..=n {
        let mut big = 0.0;
        for j in 1..=n {
            let temp = a.at(i, j).abs();
            if temp > big {
                big = temp;
            }
        }
        if big == 0.0 {
            return false;
        }
        w[i] = 1.0 / big;
    }
    for j in 1..=n {
        for i in 1..j {
            let mut sum = a.at(i, j);
            for k in 1..i {
                sum -= a.at(i, k) * a.at(k, j);
            }
            a.set(i, j, sum);
        }
        let mut big = 0.0;
        let mut imax = j;
        for i in j..=n {
            let mut sum = a.at(i, j);
            for k in 1..j {
                sum -= a.at(i, k) * a.at(k, j);
            }
            a.set(i, j, sum);
            let dum = w[i] * sum.abs();
            if dum >= big {
                big = dum;
                imax = i;
            }
        }
        if j != imax {
            for k in 1..=n {
                let dum = a.at(imax, k);
                a.set(imax, k, a.at(j, k));
                a.set(j, k, dum);
            }
            w[imax] = w[j];
        }
        indx[j] = imax;
        if a.at(j, j) == 0.0 {
            a.set(j, j, TINY1);
        }
        if j != n {
            let dum = 1.0 / a.at(j, j);
            for i in j + 1..=n {
                a.set(i, j, a.at(i, j) * dum);
            }
        }
    }
    true
}

/// `solve`: forward and back substitution after [`factorize`].
pub fn solve(a: &Matrix, n: usize, indx: &[usize], b: &mut [f64]) {
    let mut ii = 0;
    for i in 1..=n {
        let ip = indx[i];
        let mut sum = b[ip];
        b[ip] = b[i];
        if ii != 0 {
            for j in ii..i {
                sum -= a.at(i, j) * b[j];
            }
        } else if sum != 0.0 {
            ii = i;
        }
        b[i] = sum;
    }
    for i in (1..=n).rev() {
        let mut sum = b[i];
        for j in i + 1..=n {
            sum -= a.at(i, j) * b[j];
        }
        b[i] = sum / a.at(i, i);
    }
}

/// `jacobian`: central differences (forward ones at a zero value). On return `f`
/// holds the function at `x` perturbed in its last variable, as in the C code.
pub fn jacobian<S: System + ?Sized>(
    x: &mut [f64],
    n: usize,
    f: &mut [f64],
    w: &mut [f64],
    a: &mut Matrix,
    func: &mut S,
) {
    let eps = 1.0e-7;
    for j in 1..=n {
        let temp = x[j];
        x[j] = temp + eps;
        func.eval(0.0, x, n, f);
        let eps2 = if temp == 0.0 {
            x[j] = temp;
            eps
        } else {
            x[j] = temp - eps;
            2.0 * eps
        };
        func.eval(0.0, x, n, w);
        for i in 1..=n {
            a.set(i, j, (f[i] - w[i]) / eps2);
        }
        x[j] = temp;
    }
}

/// Newton-Raphson workspace (`MSXNewton`).
#[derive(Clone, Debug, Default)]
pub struct Newton {
    nmax: usize,
    indx: Vec<usize>,
    f: Vec<f64>,
    w: Vec<f64>,
    j: Matrix,
}

impl Newton {
    /// `newton_open`
    pub fn new(n: usize) -> Newton {
        Newton {
            nmax: n,
            indx: vec![0; n + 1],
            f: vec![0.0; n + 1],
            w: vec![0.0; n + 1],
            j: Matrix::new(n + 1),
        }
    }

    /// `newton_solve`: iterations taken, -1 if the Jacobian is singular, -2 if it did
    /// not converge, -3 if the system is too large.
    pub fn solve<S: System + ?Sized>(
        &mut self,
        x: &mut [f64],
        n: usize,
        maxit: i32,
        numsig: i32,
        func: &mut S,
    ) -> i32 {
        let relconvg = pow(10.0, -f64::from(numsig));
        if n > self.nmax {
            return -3;
        }
        for k in 1..=maxit {
            jacobian(x, n, &mut self.f, &mut self.w, &mut self.j, func);
            if !factorize(&mut self.j, n, &mut self.w, &mut self.indx) {
                return -1;
            }
            for i in 1..=n {
                self.f[i] = -self.f[i];
            }
            solve(&self.j, n, &self.indx, &mut self.f);
            let mut errmax = 0.0;
            for i in 1..=n {
                let mut cscal = x[i];
                if cscal < relconvg {
                    cscal = relconvg;
                }
                x[i] += self.f[i];
                let errx = (self.f[i] / cscal).abs();
                if errx > errmax {
                    errmax = errx;
                }
            }
            if errmax <= relconvg {
                return k;
            }
        }
        -2
    }
}

#[inline(always)]
fn fmin(x: f64, y: f64) -> f64 {
    if x <= y { x } else { y }
}

#[inline(always)]
fn fmax(x: f64, y: f64) -> f64 {
    if x >= y { x } else { y }
}

/// Runge-Kutta workspace (`MSXRungeKutta`).
#[derive(Clone, Debug, Default)]
pub struct Rk5 {
    itmax: i32,
    adjust: bool,
    k: [Vec<f64>; 6],
    ynew: Vec<f64>,
}

impl Rk5 {
    /// `rk5_open`
    pub fn new(n: usize, itmax: i32, adjust: bool) -> Rk5 {
        let n1 = n + 1;
        Rk5 {
            itmax,
            adjust,
            k: std::array::from_fn(|_| vec![0.0; n1]),
            ynew: vec![0.0; n1],
        }
    }

    /// `rk5_integrate`: integrate from `t` to `tnext`. Returns the number of function
    /// evaluations, -1 if it ran out of steps or -2 if the step shrank to zero.
    #[allow(clippy::too_many_arguments)]
    pub fn integrate<S: System + ?Sized>(
        &mut self,
        y: &mut [f64],
        n: usize,
        mut t: f64,
        tnext: f64,
        htry: &mut f64,
        atol: &[f64],
        rtol: &[f64],
        func: &mut S,
    ) -> i32 {
        let c2 = 0.20;
        let c3 = 0.30;
        let c4 = 0.80;
        let c5 = 8.0 / 9.0;
        let a21 = 0.20;
        let a31 = 3.0 / 40.0;
        let a32 = 9.0 / 40.0;
        let a41 = 44.0 / 45.0;
        let a42 = -56.0 / 15.0;
        let a43 = 32.0 / 9.0;
        let a51 = 19372.0 / 6561.0;
        let a52 = -25360.0 / 2187.0;
        let a53 = 64448.0 / 6561.0;
        let a54 = -212.0 / 729.0;
        let a61 = 9017.0 / 3168.0;
        let a62 = -355.0 / 33.0;
        let a63 = 46732.0 / 5247.0;
        let a64 = 49.0 / 176.0;
        let a65 = -5103.0 / 18656.0;
        let a71 = 35.0 / 384.0;
        let a73 = 500.0 / 1113.0;
        let a74 = 125.0 / 192.0;
        let a75 = -2187.0 / 6784.0;
        let a76 = 11.0 / 84.0;
        let e1 = 71.0 / 57600.0;
        let e3 = -71.0 / 16695.0;
        let e4 = 71.0 / 1920.0;
        let e5 = -17253.0 / 339200.0;
        let e6 = 22.0 / 525.0;
        let e7 = -1.0 / 40.0;

        let uround = 2.3e-16;
        let safe = 0.90;
        let fac1 = 0.2;
        let fac2 = 10.0;
        let beta = 0.04;
        let mut facold = 1.0e-4;
        let expo1 = 0.2 - beta * 0.75;
        let facc1 = 1.0 / fac1;
        let facc2 = 1.0 / fac2;
        let mut fac11 = 1.0;

        let mut nstep = 1;
        let mut nfcn = 0;
        let mut naccpt = 0;
        let mut reject = false;
        let mut adjust = self.adjust;

        let [k1, k2, k3, k4, k5, k6] = &mut self.k;
        let ynew = &mut self.ynew;

        func.eval(t, y, n, k1);
        nfcn += 1;

        let mut h = *htry;
        let hmax = tnext - t;
        if h == 0.0 {
            adjust = true;
            h = tnext - t;
            for i in 1..=n {
                let ytol = atol[i] + rtol[i] * y[i].abs();
                if k1[i] != 0.0 {
                    h = fmin(h, ytol / k1[i].abs());
                }
            }
        }
        h = fmax(1.0e-8, h);

        while t < tnext {
            if 0.10 * h.abs() <= t.abs() * uround {
                return -2;
            }
            if (t + 1.01 * h - tnext) > 0.0 {
                h = tnext - t;
            }

            let mut tnew = t + c2 * h;
            for i in 1..=n {
                ynew[i] = y[i] + h * a21 * k1[i];
            }
            func.eval(tnew, ynew, n, k2);

            tnew = t + c3 * h;
            for i in 1..=n {
                ynew[i] = y[i] + h * (a31 * k1[i] + a32 * k2[i]);
            }
            func.eval(tnew, ynew, n, k3);

            tnew = t + c4 * h;
            for i in 1..=n {
                ynew[i] = y[i] + h * (a41 * k1[i] + a42 * k2[i] + a43 * k3[i]);
            }
            func.eval(tnew, ynew, n, k4);

            tnew = t + c5 * h;
            for i in 1..=n {
                ynew[i] = y[i] + h * (a51 * k1[i] + a52 * k2[i] + a53 * k3[i] + a54 * k4[i]);
            }
            func.eval(tnew, ynew, n, k5);

            tnew = t + h;
            for i in 1..=n {
                ynew[i] = y[i]
                    + h * (a61 * k1[i] + a62 * k2[i] + a63 * k3[i] + a64 * k4[i] + a65 * k5[i]);
            }
            func.eval(tnew, ynew, n, k6);

            for i in 1..=n {
                ynew[i] = y[i]
                    + h * (a71 * k1[i] + a73 * k3[i] + a74 * k4[i] + a75 * k5[i] + a76 * k6[i]);
            }
            func.eval(tnew, ynew, n, k2);
            nfcn += 6;

            let mut err = 0.0;
            let mut hnew = h;
            if adjust {
                for i in 1..=n {
                    k4[i] = (e1 * k1[i]
                        + e3 * k3[i]
                        + e4 * k4[i]
                        + e5 * k5[i]
                        + e6 * k6[i]
                        + e7 * k2[i])
                        * h;
                }
                for i in 1..=n {
                    let mut sk = atol[i] + rtol[i] * fmax(y[i].abs(), ynew[i].abs());
                    sk = k4[i] / sk;
                    err += sk * sk;
                }
                err = (err / n as f64).sqrt();

                fac11 = pow(err, expo1);
                let mut fac = fac11 / pow(facold, beta);
                fac = fmax(facc2, fmin(facc1, fac / safe));
                hnew = h / fac;
            }

            if err <= 1.0 {
                facold = fmax(err, 1.0e-4);
                naccpt += 1;
                for i in 1..=n {
                    k1[i] = k2[i];
                    y[i] = ynew[i];
                }
                t += h;
                if adjust && t <= tnext {
                    *htry = h;
                }
                if hnew.abs() > hmax {
                    hnew = hmax;
                }
                if reject {
                    hnew = fmin(hnew.abs(), h.abs());
                }
                reject = false;
            } else {
                if adjust {
                    hnew = h / fmin(facc1, fac11 / safe);
                }
                reject = true;
            }

            h = hnew;
            if adjust {
                *htry = h;
            }
            nstep += 1;
            if nstep >= self.itmax {
                return -1;
            }
        }
        let _ = naccpt;
        nfcn
    }
}

/// Rosenbrock workspace (`MSXRosenbrock`).
#[derive(Clone, Debug, Default)]
pub struct Ros2 {
    adjust: bool,
    a: Matrix,
    k1: Vec<f64>,
    k2: Vec<f64>,
    ynew: Vec<f64>,
    jindx: Vec<usize>,
}

impl Ros2 {
    /// `ros2_open`
    pub fn new(n: usize, adjust: bool) -> Ros2 {
        let n1 = n + 1;
        Ros2 {
            adjust,
            a: Matrix::new(n1),
            k1: vec![0.0; n1],
            k2: vec![0.0; n1],
            ynew: vec![0.0; n1],
            jindx: vec![0; n1],
        }
    }

    /// `ros2_integrate`: number of function evaluations, -1 if the Jacobian is
    /// singular or -2 if the step size shrank to zero.
    #[allow(clippy::too_many_arguments)]
    pub fn integrate<S: System + ?Sized>(
        &mut self,
        y: &mut [f64],
        n: usize,
        mut t: f64,
        tnext: f64,
        htry: &mut f64,
        atol: &[f64],
        rtol: &[f64],
        func: &mut S,
    ) -> i32 {
        let uround = 2.3e-16;
        let mut adjust = self.adjust;
        let g = 1.0 + 1.0 / 2f64.sqrt();
        let mut ghinv1 = 0.0;
        let mut is_reject = false;
        let mut nfcn = 0;

        let hmax = tnext - t;
        let hmin = 1.0e-8;
        let mut h = *htry;
        if h == 0.0 {
            func.eval(t, y, n, &mut self.k1);
            nfcn += 1;
            adjust = true;
            h = tnext - t;
            for j in 1..=n {
                let ytol = atol[j] + rtol[j] * y[j].abs();
                if self.k1[j] != 0.0 {
                    h = fmin(h, ytol / self.k1[j].abs());
                }
            }
        }
        h = fmax(hmin, h);
        h = fmin(hmax, h);

        while t < tnext {
            if 0.10 * h.abs() <= t.abs() * uround {
                return -2;
            }
            let mut tplus = t + h;
            if tplus > tnext {
                h = tnext - t;
                tplus = tnext;
            }

            if !is_reject {
                jacobian(y, n, &mut self.k1, &mut self.k2, &mut self.a, func);
                nfcn += 2 * n as i32;
                ghinv1 = 0.0;
            }

            let ghinv = -1.0 / (g * h);
            let dghinv = ghinv - ghinv1;
            for j in 1..=n {
                let v = self.a.at(j, j) + dghinv;
                self.a.set(j, j, v);
            }
            ghinv1 = ghinv;
            if !factorize(&mut self.a, n, &mut self.k1, &mut self.jindx) {
                return -1;
            }

            // --- stage 1
            func.eval(t, y, n, &mut self.k1);
            nfcn += 1;
            for j in 1..=n {
                self.k1[j] *= ghinv;
            }
            solve(&self.a, n, &self.jindx, &mut self.k1);

            // --- stage 2
            for j in 1..=n {
                self.ynew[j] = y[j] + h * self.k1[j];
            }
            func.eval(t, &self.ynew, n, &mut self.k2);
            nfcn += 1;
            for j in 1..=n {
                self.k2[j] = (self.k2[j] - 2.0 * self.k1[j]) * ghinv;
            }
            solve(&self.a, n, &self.jindx, &mut self.k2);

            // --- overall solution
            for j in 1..=n {
                self.ynew[j] = y[j] + 1.5 * h * self.k1[j] + 0.5 * h * self.k2[j];
            }

            // --- error estimation
            let mut err = 0.0;
            if adjust {
                for j in 1..=n {
                    let ytol = atol[j] + rtol[j] * self.ynew[j].abs();
                    let ej = (self.ynew[j] - y[j] - h * self.k1[j]).abs() / ytol;
                    err += ej * ej;
                }
                err = (err / n as f64).sqrt();
                err = fmax(uround, err);

                let mut factor = 0.9 / err.sqrt();
                let facmax = if is_reject { 1.0 } else { 10.0 };
                factor = fmin(factor, facmax);
                factor = fmax(factor, 1.0e-1);
                h *= factor;
                h = fmin(hmax, h);
            }

            if err > 1.0 {
                is_reject = true;
                h *= 0.5;
            } else {
                is_reject = false;
                for j in 1..=n {
                    y[j] = self.ynew[j];
                    if y[j] <= uround {
                        y[j] = 0.0;
                    }
                }
                if adjust {
                    *htry = h;
                }
                t = tplus;
            }
        }
        nfcn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// dy/dt = -k y, with y(0) = 1.
    struct Decay(f64);
    impl System for Decay {
        fn eval(&mut self, _t: f64, y: &[f64], n: usize, f: &mut [f64]) {
            for i in 1..=n {
                f[i] = -self.0 * y[i];
            }
        }
    }

    #[test]
    fn rk5_and_ros2_integrate_first_order_decay() {
        let exact = (-2.0f64).exp();
        let mut y = vec![0.0, 1.0];
        let mut h = 0.0;
        let r = Rk5::new(1, 1000, true).integrate(
            &mut y,
            1,
            0.0,
            1.0,
            &mut h,
            &[0.0, 1e-10],
            &[0.0, 1e-8],
            &mut Decay(2.0),
        );
        assert!(r > 0);
        assert!((y[1] - exact).abs() < 1e-7, "{}", y[1]);

        let mut y = vec![0.0, 1.0];
        let mut h = 0.0;
        let r = Ros2::new(1, true).integrate(
            &mut y,
            1,
            0.0,
            1.0,
            &mut h,
            &[0.0, 1e-10],
            &[0.0, 1e-6],
            &mut Decay(2.0),
        );
        assert!(r > 0);
        assert!((y[1] - exact).abs() < 1e-4, "{}", y[1]);
    }

    /// x^2 - 4 = 0 and x*y - 6 = 0.
    struct Pair;
    impl System for Pair {
        fn eval(&mut self, _t: f64, x: &[f64], _n: usize, f: &mut [f64]) {
            f[1] = x[1] * x[1] - 4.0;
            f[2] = x[1] * x[2] - 6.0;
        }
    }

    #[test]
    fn newton_solves_a_small_system() {
        let mut x = vec![0.0, 1.0, 1.0];
        let k = Newton::new(2).solve(&mut x, 2, 20, 6, &mut Pair);
        assert!(k > 0);
        assert!(
            (x[1] - 2.0).abs() < 1e-6 && (x[2] - 3.0).abs() < 1e-6,
            "{x:?}"
        );
    }

    #[test]
    fn lu_solves_with_pivoting() {
        let mut a = Matrix::new(3);
        a.set(1, 1, 0.0);
        a.set(1, 2, 2.0);
        a.set(2, 1, 3.0);
        a.set(2, 2, 1.0);
        let mut w = vec![0.0; 3];
        let mut indx = vec![0; 3];
        assert!(factorize(&mut a, 2, &mut w, &mut indx));
        let mut b = vec![0.0, 4.0, 5.0];
        solve(&a, 2, &indx, &mut b);
        assert!(
            (b[1] - 1.0).abs() < 1e-12 && (b[2] - 2.0).abs() < 1e-12,
            "{b:?}"
        );
    }
}
