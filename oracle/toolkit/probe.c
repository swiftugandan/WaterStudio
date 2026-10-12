/*
 * Exercises the EPANET 2.3 toolkit API on one network and prints what every call
 * returns, so two builds (OWA-EPANET's libepanet2 and WaterStudio's ws-ffi) can be
 * compared line for line. Arrays print a 64-bit FNV-1a hash of every value's bits and
 * error code, plus the first few values in full (%.17g) to help debugging.
 *
 *   probe <net.inp> [scratch-dir]
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "epanet2_2.h"

#define SHOW 8
static EN_Project ph;
static char scratch[512] = "/tmp";

typedef struct { uint64_t h; } Hash;
static void hinit(Hash *x) { x->h = 1469598103934665603ULL; }
static void hbytes(Hash *x, const void *p, size_t n) {
  const unsigned char *b = p;
  for (size_t i = 0; i < n; i++) { x->h ^= b[i]; x->h *= 1099511628211ULL; }
}
static void hval(Hash *x, int err, double v) { hbytes(x, &err, sizeof err); hbytes(x, &v, sizeof v); }

static int nnodes, nlinks, npats, ncurves, ncontrols, nrules;
/* A source made by EN_setnodevalue has no mass until a quality run sets it: OWA-EPANET
   leaves the field uninitialised, so EN_SOURCEMASS is not read after the setters. */
static int mutated;

static void nodeprop(const char *tag, int prop) {
  Hash x; hinit(&x);
  printf("%s node.%d", tag, prop);
  for (int i = 1; i <= nnodes; i++) {
    double v = -12345.0;
    int e = EN_getnodevalue(ph, i, prop, &v);
    hval(&x, e, v);
    if (i <= SHOW) printf(" %d:%.17g", e, v);
  }
  printf(" #%016llx\n", (unsigned long long)x.h);
}

static void linkprop(const char *tag, int prop) {
  Hash x; hinit(&x);
  printf("%s link.%d", tag, prop);
  for (int i = 1; i <= nlinks; i++) {
    double v = -12345.0;
    int e = EN_getlinkvalue(ph, i, prop, &v);
    hval(&x, e, v);
    if (i <= SHOW) printf(" %d:%.17g", e, v);
  }
  printf(" #%016llx\n", (unsigned long long)x.h);
}

static void arrays(const char *tag) {
  /* EN_getnodevalues / EN_getlinkvalues must agree with the single getters. */
  double *a = calloc(nnodes + 1, sizeof(double));
  double *b = calloc(nlinks + 1, sizeof(double));
  Hash x; hinit(&x);
  int e = EN_getnodevalues(ph, EN_HEAD, a);
  hbytes(&x, &e, sizeof e); hbytes(&x, a, sizeof(double) * nnodes);
  e = EN_getlinkvalues(ph, EN_FLOW, b);
  hbytes(&x, &e, sizeof e); hbytes(&x, b, sizeof(double) * nlinks);
  printf("%s values #%016llx\n", tag, (unsigned long long)x.h);
  free(a); free(b);
}

static void stats(const char *tag) {
  printf("%s stat", tag);
  for (int s = 0; s <= 7; s++) {
    double v = -1; int e = EN_getstatistic(ph, s, &v);
    printf(" %d:%.17g", e, v);
  }
  printf("\n%s time", tag);
  for (int t = EN_HTIME; t <= EN_NEXTEVENTTANK; t++) {
    long v = -1; int e = EN_gettimeparam(ph, t, &v);
    printf(" %d:%ld", e, v);
  }
  long v = -1; int ev = EN_gettimeparam(ph, EN_PERIODS, &v);
  printf(" periods %d:%ld\n", ev, v);
}

static const int DYN_NODE[] = {EN_DEMAND, EN_HEAD, EN_PRESSURE, EN_QUALITY, EN_TANKVOLUME, EN_TANKLEVEL,
                               EN_DEMANDDEFICIT, EN_EMITTERFLOW, EN_LEAKAGEFLOW, EN_DEMANDFLOW, EN_FULLDEMAND};
static const int DYN_LINK[] = {EN_FLOW, EN_VELOCITY, EN_HEADLOSS, EN_STATUS, EN_SETTING, EN_ENERGY, EN_LINKQUAL,
                               EN_PUMP_STATE, EN_PUMP_EFFIC, EN_LINK_LEAKAGE};

static void dynamic(const char *tag) {
  for (size_t i = 0; i < sizeof DYN_NODE / sizeof *DYN_NODE; i++) nodeprop(tag, DYN_NODE[i]);
  for (size_t i = 0; i < sizeof DYN_LINK / sizeof *DYN_LINK; i++) linkprop(tag, DYN_LINK[i]);
  stats(tag);
}

static void quality(const char *tag) {
  nodeprop(tag, EN_QUALITY);
  linkprop(tag, EN_LINKQUAL);
  nodeprop(tag, EN_HEAD);
  nodeprop(tag, EN_DEMAND);
  linkprop(tag, EN_FLOW);
  double mb = 0; int e = EN_getstatistic(ph, EN_MASSBALANCE, &mb);
  printf("%s massbalance %d:%.17g\n", tag, e, mb);
}

static void statics(void) {
  char s1[EN_MAXMSG + 1], s2[EN_MAXMSG + 1], s3[EN_MAXMSG + 1];
  int v, e;
  printf("counts %d %d %d %d %d %d\n", nnodes, nlinks, npats, ncurves, ncontrols, nrules);
  int tanks; EN_getcount(ph, EN_TANKCOUNT, &tanks);
  printf("tanks %d badcount %d\n", tanks, EN_getcount(ph, 99, &v));
  /* EN_gettitle copies a 79-character title without a terminator: zero the buffers. */
  memset(s1, 0, sizeof s1); memset(s2, 0, sizeof s2); memset(s3, 0, sizeof s3);
  e = EN_gettitle(ph, s1, s2, s3);
  printf("title %d [%s] [%s] [%s]\n", e, s1, s2, s3);
  e = EN_getflowunits(ph, &v); printf("flowunits %d %d\n", e, v);
  printf("options");
  for (int o = 0; o <= 26; o++) { double d = -1; e = EN_getoption(ph, o, &d); printf(" %d:%.17g", e, d); }
  printf(" bad %d\n", EN_getoption(ph, 99, &(double){0}));
  printf("times");
  for (int t = 0; t <= EN_NEXTEVENTTANK; t++) { long d = -1; e = EN_gettimeparam(ph, t, &d); printf(" %d:%ld", e, d); }
  printf("\n");
  int qt, tn; e = EN_getqualtype(ph, &qt, &tn); printf("qualtype %d %d %d\n", e, qt, tn);
  s1[0] = s2[0] = 0; e = EN_getqualinfo(ph, &qt, s1, s2, &tn); printf("qualinfo %d %d [%s] [%s] %d\n", e, qt, s1, s2, tn);
  double pmin, preq, pexp; e = EN_getdemandmodel(ph, &v, &pmin, &preq, &pexp);
  printf("demandmodel %d %d %.17g %.17g %.17g\n", e, v, pmin, preq, pexp);

  Hash x; hinit(&x);
  for (int i = 1; i <= nnodes; i++) {
    int t, k, nd; double xx = 0, yy = 0;
    char id[EN_MAXID + 1] = "", c[EN_MAXMSG + 1] = "", tag[EN_MAXMSG + 1] = "";
    e = EN_getnodeid(ph, i, id); hbytes(&x, &e, sizeof e); hbytes(&x, id, strlen(id));
    e = EN_getnodeindex(ph, id, &k); hbytes(&x, &e, sizeof e); hbytes(&x, &k, sizeof k);
    e = EN_getnodetype(ph, i, &t); hbytes(&x, &e, sizeof e); hbytes(&x, &t, sizeof t);
    e = EN_getcomment(ph, EN_NODE, i, c); hbytes(&x, &e, sizeof e); hbytes(&x, c, strlen(c));
    e = EN_gettag(ph, EN_NODE, i, tag); hbytes(&x, &e, sizeof e); hbytes(&x, tag, strlen(tag));
    e = EN_getcoord(ph, i, &xx, &yy); hval(&x, e, xx); hval(&x, e, yy);
    e = EN_getresultindex(ph, EN_NODE, i, &k); hbytes(&x, &e, sizeof e); hbytes(&x, &k, sizeof k);
    e = EN_getnumdemands(ph, i, &nd); hbytes(&x, &e, sizeof e); hbytes(&x, &nd, sizeof nd);
    for (int d = 1; d <= nd; d++) {
      double base = 0; int pat = 0; char dn[EN_MAXID + 1] = ""; int di = 0;
      e = EN_getbasedemand(ph, i, d, &base); hval(&x, e, base);
      e = EN_getdemandpattern(ph, i, d, &pat); hbytes(&x, &e, sizeof e); hbytes(&x, &pat, sizeof pat);
      e = EN_getdemandname(ph, i, d, dn); hbytes(&x, &e, sizeof e); hbytes(&x, dn, strlen(dn));
      e = EN_getdemandindex(ph, i, dn, &di); hbytes(&x, &e, sizeof e); hbytes(&x, &di, sizeof di);
    }
    if (i <= SHOW) printf("node %d %s t%d [%s] [%s] %.17g %.17g nd%d\n", i, id, t, c, tag, xx, yy, nd);
  }
  printf("nodes #%016llx\n", (unsigned long long)x.h);
  /* Computed values are read only after a solver has run: before that EPANET's hold
     what parsing left in them (raw [JUNCTIONS] demands, say), which no model keeps. */
  for (int p = 0; p <= EN_FULLDEMAND; p++) {
    int dyn = 0;
    for (size_t i = 0; i < sizeof DYN_NODE / sizeof *DYN_NODE; i++) dyn |= DYN_NODE[i] == p;
    if (!dyn && !(mutated && p == EN_SOURCEMASS)) nodeprop("static", p);
  }

  hinit(&x);
  for (int i = 1; i <= nlinks; i++) {
    int t, k, n1, n2, nv; double xx, yy;
    char id[EN_MAXID + 1] = "", c[EN_MAXMSG + 1] = "", tag[EN_MAXMSG + 1] = "";
    e = EN_getlinkid(ph, i, id); hbytes(&x, &e, sizeof e); hbytes(&x, id, strlen(id));
    e = EN_getlinkindex(ph, id, &k); hbytes(&x, &e, sizeof e); hbytes(&x, &k, sizeof k);
    e = EN_getlinktype(ph, i, &t); hbytes(&x, &e, sizeof e); hbytes(&x, &t, sizeof t);
    e = EN_getlinknodes(ph, i, &n1, &n2); hbytes(&x, &e, sizeof e); hbytes(&x, &n1, sizeof n1); hbytes(&x, &n2, sizeof n2);
    e = EN_getcomment(ph, EN_LINK, i, c); hbytes(&x, &e, sizeof e); hbytes(&x, c, strlen(c));
    e = EN_gettag(ph, EN_LINK, i, tag); hbytes(&x, &e, sizeof e); hbytes(&x, tag, strlen(tag));
    e = EN_getresultindex(ph, EN_LINK, i, &k); hbytes(&x, &e, sizeof e); hbytes(&x, &k, sizeof k);
    e = EN_getvertexcount(ph, i, &nv); hbytes(&x, &e, sizeof e); hbytes(&x, &nv, sizeof nv);
    for (int j = 1; j <= nv; j++) { e = EN_getvertex(ph, i, j, &xx, &yy); hval(&x, e, xx); hval(&x, e, yy); }
    if (t == EN_PUMP) {
      int pt = -1, hc = -1;
      e = EN_getpumptype(ph, i, &pt); hbytes(&x, &e, sizeof e); hbytes(&x, &pt, sizeof pt);
      e = EN_getheadcurveindex(ph, i, &hc); hbytes(&x, &e, sizeof e); hbytes(&x, &hc, sizeof hc);
      if (i <= 4 * SHOW) printf("pump %d type %d curve %d\n", i, pt, hc);
    }
    if (i <= SHOW) printf("link %d %s t%d %d-%d [%s] [%s] nv%d\n", i, id, t, n1, n2, c, tag, nv);
  }
  printf("links #%016llx\n", (unsigned long long)x.h);
  for (int p = 0; p <= EN_VALVE_TYPE; p++) {
    int dyn = 0;
    for (size_t i = 0; i < sizeof DYN_LINK / sizeof *DYN_LINK; i++) dyn |= DYN_LINK[i] == p;
    if (!dyn) linkprop("static", p);
  }

  for (int i = 1; i <= npats; i++) {
    char id[EN_MAXID + 1] = "", c[EN_MAXMSG + 1] = ""; int len = 0, k = 0; double avg = 0;
    EN_getpatternid(ph, i, id); EN_getpatternindex(ph, id, &k); EN_getpatternlen(ph, i, &len);
    EN_getaveragepatternvalue(ph, i, &avg); EN_getcomment(ph, EN_TIMEPAT, i, c);
    hinit(&x);
    for (int j = 0; j <= len + 1; j++) { double f = -1; e = EN_getpatternvalue(ph, i, j, &f); hval(&x, e, f); }
    printf("pattern %d %s %d %d %.17g [%s] #%016llx\n", i, id, k, len, avg, c, (unsigned long long)x.h);
  }
  for (int i = 1; i <= ncurves; i++) {
    char id[EN_MAXID + 1] = "", id2[EN_MAXID + 1] = "", c[EN_MAXMSG + 1] = ""; int len = 0, k = 0, t = -1, n = 0;
    EN_getcurveid(ph, i, id); EN_getcurveindex(ph, id, &k); EN_getcurvelen(ph, i, &len); EN_getcurvetype(ph, i, &t);
    EN_getcomment(ph, EN_CURVE, i, c);
    hinit(&x);
    for (int j = 0; j <= len + 1; j++) {
      double a = -1, b = -1; e = EN_getcurvevalue(ph, i, j, &a, &b); hval(&x, e, a); hval(&x, e, b);
    }
    double *xs = calloc(len + 1, sizeof(double)), *ys = calloc(len + 1, sizeof(double));
    e = EN_getcurve(ph, i, id2, &n, xs, ys); hbytes(&x, &e, sizeof e); hbytes(&x, id2, strlen(id2));
    hbytes(&x, xs, sizeof(double) * n); hbytes(&x, ys, sizeof(double) * n);
    free(xs); free(ys);
    printf("curve %d %s %d %d type %d [%s] #%016llx\n", i, id, k, len, t, c, (unsigned long long)x.h);
  }
  for (int i = 0; i <= ncontrols + 1; i++) {
    int t = -1, l = -1, n = -1, en = -1; double s = -1, lv = -1;
    e = EN_getcontrol(ph, i, &t, &l, &s, &n, &lv);
    int e2 = EN_getcontrolenabled(ph, i, &en);
    printf("control %d %d: %d %d %.17g %d %.17g | %d %d\n", i, e, t, l, s, n, lv, e2, en);
  }
  printf("errors");
  int bad[] = {EN_getnodevalue(ph, 0, 0, &(double){0}), EN_getnodevalue(ph, 1, 99, &(double){0}),
               EN_getlinkvalue(ph, nlinks + 1, 0, &(double){0}), EN_getnodeindex(ph, "no such node", &v),
               EN_getlinkindex(ph, "no such link", &v), EN_getpatternindex(ph, "no such pattern", &v),
               EN_getcurveindex(ph, "no such curve", &v), EN_getpatternvalue(ph, npats + 1, 1, &(double){0}),
               EN_getcurvevalue(ph, ncurves + 1, 1, &(double){0}, &(double){0})};
  for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) printf(" %d", bad[i]);
  printf("\n");
}


static void counts(void) {
  EN_getcount(ph, EN_NODECOUNT, &nnodes);
  EN_getcount(ph, EN_LINKCOUNT, &nlinks);
  EN_getcount(ph, EN_PATCOUNT, &npats);
  EN_getcount(ph, EN_CURVECOUNT, &ncurves);
  EN_getcount(ph, EN_CONTROLCOUNT, &ncontrols);
  EN_getcount(ph, EN_RULECOUNT, &nrules);
}

#define SET(call) printf("set %s = %d\n", #call, (call))

/* Change every kind of property through the setters, printing each return code. */
static void mutate(void) {
  int us = 0, units = 0, tank = 0, pump = 0, pipe = 0, valve = 0, pat = 0, crv = 0, ci = 0;
  double v, vx[3] = {1, 2, 3}, vy[3] = {4, 5, 6};
  EN_getflowunits(ph, &units);
  us = units <= EN_AFD;

  SET(EN_settitle(ph, "Mutated", "by the probe",
                  "a third line long enough to be cut at seventy-nine characters ...................."));
  SET(EN_setcomment(ph, EN_NODE, 1, "a comment"));
  SET(EN_setcomment(ph, EN_LINK, 1, ""));
  SET(EN_setcomment(ph, EN_NODE, nnodes + 1, "x"));
  SET(EN_settag(ph, EN_NODE, 1, "tagged"));
  SET(EN_settag(ph, EN_LINK, 1, "tag2"));
  SET(EN_setcoord(ph, 1, 12.5, -3.25));
  SET(EN_setvertices(ph, 1, vx, vy, 3));
  SET(EN_setvertex(ph, 1, 2, 7, 8));
  SET(EN_setvertex(ph, 1, 9, 0, 0));
  SET(EN_setnodeid(ph, 1, "N1x"));
  SET(EN_setnodeid(ph, 2, "N1x"));
  SET(EN_setnodeid(ph, 2, "bad id"));
  SET(EN_setlinkid(ph, 1, "L1x"));
  SET(EN_setlinkid(ph, nlinks + 1, "L2x"));

  /* Options, valid and not. */
  int opts[] = {EN_TRIALS, EN_ACCURACY, EN_TOLERANCE, EN_DEMANDMULT, EN_HEADERROR, EN_FLOWCHANGE,
                EN_GLOBALEFFIC, EN_GLOBALPRICE, EN_DEMANDCHARGE, EN_SP_VISCOS, EN_CHECKFREQ, EN_MAXCHECK,
                EN_DAMPLIMIT, EN_SP_DIFFUS, EN_BULKORDER, EN_WALLORDER, EN_TANKORDER, EN_CONCENLIMIT,
                EN_EMITBACKFLOW, EN_UNBALANCED, EN_SP_GRAVITY, EN_EMITEXPON, EN_ACCURACY, EN_TRIALS,
                EN_WALLORDER, EN_GLOBALEFFIC, EN_STATUS_REPORT};
  double vals[] = {60, 0.0005, 0.02, 1.1, 0, 0, 80, 0.1, 1, 1.05, 3, 12, 0, 1.1, 1, 1, 1, 0, 1, 10, 1.02,
                   0.55, 2, 0, 0.5, 0.5, 0};
  for (size_t i = 0; i < sizeof opts / sizeof *opts; i++)
    printf("set option %d %g = %d\n", opts[i], vals[i], EN_setoption(ph, opts[i], vals[i]));
  EN_getoption(ph, EN_HEADLOSSFORM, &v);
  SET(EN_setoption(ph, EN_HEADLOSSFORM, v));
  SET(EN_setoption(ph, 99, 1));

  /* Times. */
  long dur = 0, hstep = 0;
  EN_gettimeparam(ph, EN_DURATION, &dur);
  EN_gettimeparam(ph, EN_HYDSTEP, &hstep);
  SET(EN_settimeparam(ph, EN_DURATION, dur > 0 ? dur / 2 : 0));
  SET(EN_settimeparam(ph, EN_QUALSTEP, 120));
  SET(EN_settimeparam(ph, EN_PATTERNSTART, 3600));
  SET(EN_settimeparam(ph, EN_REPORTSTART, 0));
  SET(EN_settimeparam(ph, EN_RULESTEP, 60));
  SET(EN_settimeparam(ph, EN_STARTTIME, 3600));
  SET(EN_settimeparam(ph, EN_HYDSTEP, 0));
  SET(EN_settimeparam(ph, EN_HYDSTEP, hstep));
  SET(EN_settimeparam(ph, EN_STATISTIC, 9));

  /* A pattern and a curve. */
  double pv[5] = {0.5, 1.0, 1.5, 1.2, 0.8};
  SET(EN_addpattern(ph, "PX"));
  SET(EN_addpattern(ph, "PX"));
  SET(EN_getpatternindex(ph, "PX", &pat));
  SET(EN_setpattern(ph, pat, pv, 5));
  SET(EN_setpatternvalue(ph, pat, 2, 1.1));
  SET(EN_setpatternvalue(ph, pat, 6, 1.1));
  SET(EN_setpatternid(ph, pat, "PY"));
  SET(EN_setcomment(ph, EN_TIMEPAT, pat, "added"));
  double cx[3] = {0, 100, 200}, cy[3] = {100, 80, 50};
  SET(EN_addcurve(ph, "CX"));
  SET(EN_getcurveindex(ph, "CX", &crv));
  SET(EN_setcurve(ph, crv, cx, cy, 3));
  SET(EN_setcurvevalue(ph, crv, 2, 110, 79));
  SET(EN_setcurvevalue(ph, crv, 4, 300, 20));
  SET(EN_setcurvevalue(ph, crv, 2, 500, 0));
  SET(EN_setcurvetype(ph, crv, EN_PUMP_CURVE));
  SET(EN_setcurveid(ph, crv, "CY"));
  counts();

  /* Nodes. */
  for (int i = 1; i <= nnodes; i++) {
    int t; EN_getnodetype(ph, i, &t);
    if (t == EN_JUNCTION) {
      if (i % 5 == 0) { EN_getnodevalue(ph, i, EN_ELEVATION, &v); printf("n%d el %d\n", i, EN_setnodevalue(ph, i, EN_ELEVATION, v + 1)); }
      if (i % 3 == 0) { EN_getnodevalue(ph, i, EN_BASEDEMAND, &v); printf("n%d bd %d\n", i, EN_setnodevalue(ph, i, EN_BASEDEMAND, v * 1.2)); }
      if (i % 9 == 0) printf("n%d em %d\n", i, EN_setnodevalue(ph, i, EN_EMITTER, 0.2));
      if (i % 7 == 0) printf("n%d ad %d\n", i, EN_adddemand(ph, i, 1.5, "PY", "extra"));
      if (i % 8 == 0) printf("n%d dn %d %d\n", i, EN_setdemandname(ph, i, 1, "main"), EN_setdemandpattern(ph, i, 1, pat));
      if (i % 11 == 0) printf("n%d dd %d\n", i, EN_deletedemand(ph, i, 1));
      if (i % 13 == 0) printf("n%d sb %d\n", i, EN_setbasedemand(ph, i, 1, 2.5));
      if (i % 17 == 0) printf("n%d jd %d\n", i, EN_setjuncdata(ph, i, 50, 3, "PY"));
      if (i % 4 == 0) printf("n%d iq %d\n", i, EN_setnodevalue(ph, i, EN_INITQUAL, 0.3));
      if (i == 1) printf("n%d tl %d\n", i, EN_setnodevalue(ph, i, EN_TANKLEVEL, 1));
    } else if (t == EN_TANK) {
      double lo, hi, d;
      tank = tank ? tank : i;
      EN_getnodevalue(ph, i, EN_MINLEVEL, &lo); EN_getnodevalue(ph, i, EN_MAXLEVEL, &hi);
      EN_getnodevalue(ph, i, EN_TANKDIAM, &d);
      printf("t%d %d %d %d %d %d %d\n", i, EN_setnodevalue(ph, i, EN_TANKLEVEL, (lo + hi) / 2),
             EN_setnodevalue(ph, i, EN_MIXMODEL, 1), EN_setnodevalue(ph, i, EN_MIXFRACTION, 0.6),
             EN_setnodevalue(ph, i, EN_TANK_KBULK, -0.3), EN_setnodevalue(ph, i, EN_CANOVERFLOW, 1),
             EN_setnodevalue(ph, i, EN_MAXLEVEL, hi + 0.5));
      if (i % 2 == 0) printf("t%d d %d %d\n", i, EN_setnodevalue(ph, i, EN_TANKDIAM, d * 1.1), EN_setnodevalue(ph, i, EN_MINVOLUME, 0));
      else printf("t%d ml %d\n", i, EN_setnodevalue(ph, i, EN_MINLEVEL, lo + 0.1));
    } else {
      EN_getnodevalue(ph, i, EN_ELEVATION, &v);
      printf("r%d %d %d\n", i, EN_setnodevalue(ph, i, EN_TANKLEVEL, v + 0.5), EN_setnodevalue(ph, i, EN_PATTERN, 0));
      printf("r%d mix %d\n", i, EN_setnodevalue(ph, i, EN_MIXMODEL, 2));
    }
  }
  SET(EN_setnodevalue(ph, 1, EN_SOURCEQUAL, 1.5));
  SET(EN_setnodevalue(ph, 1, EN_SOURCETYPE, EN_SETPOINT));
  SET(EN_setnodevalue(ph, 1, EN_SOURCEPAT, pat));
  SET(EN_setnodevalue(ph, 1, EN_SOURCEPAT, npats + 5));
  SET(EN_setnodevalue(ph, 1, 99, 0));

  /* Links. */
  for (int k = 1; k <= nlinks; k++) {
    int t; EN_getlinktype(ph, k, &t);
    if (t <= EN_PIPE) {
      if (t == EN_PIPE && !pipe) pipe = k;
      if (k % 3 == 0) {
        double d, r, l;
        EN_getlinkvalue(ph, k, EN_DIAMETER, &d); EN_getlinkvalue(ph, k, EN_ROUGHNESS, &r); EN_getlinkvalue(ph, k, EN_LENGTH, &l);
        printf("p%d %d %d %d %d %d %d\n", k, EN_setlinkvalue(ph, k, EN_DIAMETER, d * 1.05),
               EN_setlinkvalue(ph, k, EN_ROUGHNESS, r * 0.95), EN_setlinkvalue(ph, k, EN_MINORLOSS, 0.3),
               EN_setlinkvalue(ph, k, EN_LENGTH, l * 1.02), EN_setlinkvalue(ph, k, EN_KBULK, -0.4),
               EN_setlinkvalue(ph, k, EN_KWALL, -0.1));
      }
      if (k % 13 == 0) printf("p%d leak %d %d\n", k, EN_setlinkvalue(ph, k, EN_LEAK_AREA, 0.5), EN_setlinkvalue(ph, k, EN_LEAK_EXPAN, 0.1));
      if (k % 17 == 0) printf("p%d st %d\n", k, EN_setlinkvalue(ph, k, EN_INITSTATUS, 0));
      if (k % 19 == 0) { EN_getlinkvalue(ph, k, EN_ROUGHNESS, &v); printf("p%d is %d\n", k, EN_setlinkvalue(ph, k, EN_INITSETTING, v * 1.1)); }
    } else if (t == EN_PUMP) {
      pump = pump ? pump : k;
      printf("u%d %d %d %d %d\n", k, EN_setlinkvalue(ph, k, EN_INITSETTING, 0.95), EN_setlinkvalue(ph, k, EN_PUMP_ECOST, 0.05),
             EN_setlinkvalue(ph, k, EN_LINKPATTERN, 0), EN_setlinkvalue(ph, k, EN_PUMP_EPAT, pat));
    } else {
      valve = valve ? valve : k;
      EN_getlinkvalue(ph, k, EN_INITSETTING, &v);
      printf("v%d %d %d\n", k, EN_setlinkvalue(ph, k, EN_INITSETTING, v * 1.1), EN_setlinkvalue(ph, k, EN_MINORLOSS, 0.2));
      if (t == EN_TCV) printf("v%d type %d\n", k, EN_setlinkvalue(ph, k, EN_VALVE_TYPE, EN_PCV));
      if (t == EN_PSV) printf("v%d type %d\n", k, EN_setlinkvalue(ph, k, EN_VALVE_TYPE, EN_PRV));
    }
  }
  if (pipe) {
    double l, d, r;
    EN_getlinkvalue(ph, pipe, EN_LENGTH, &l); EN_getlinkvalue(ph, pipe, EN_DIAMETER, &d); EN_getlinkvalue(ph, pipe, EN_ROUGHNESS, &r);
    SET(EN_setpipedata(ph, pipe, l * 1.1, d, r, 0.5));
    SET(EN_setlinkvalue(ph, pipe, EN_DIAMETER, -1));
  }
  if (pump) {
    SET(EN_setheadcurveindex(ph, pump, crv));
    SET(EN_setlinkvalue(ph, pump, EN_PUMP_ECURVE, ncurves + 3));
  }
  SET(EN_setlinkvalue(ph, 1, 99, 0));

  /* Controls. */
  if (pipe) {
    SET(EN_addcontrol(ph, EN_TIMER, pipe, 0, 0, 7200, &ci));
    SET(EN_setcontrol(ph, ci, EN_TIMER, pipe, EN_SET_OPEN, 0, 10800));
    if (tank) SET(EN_addcontrol(ph, EN_LOWLEVEL, pipe, EN_SET_CLOSED, tank, 0.5, &ci));
    SET(EN_addcontrol(ph, 7, pipe, 0, 0, 0, &ci));
    if (valve) SET(EN_addcontrol(ph, EN_TIMEOFDAY, valve, 12, 0, 3600 * 5, &ci));
  }
  counts();
  if (ncontrols >= 1) SET(EN_setcontrolenabled(ph, 1, 0));
  SET(EN_setcontrolenabled(ph, 1, 2));
  if (ncontrols >= 2) SET(EN_deletecontrol(ph, ncontrols));
  SET(EN_deletecontrol(ph, 0));

  /* Demand model, quality and, last, flow units. */
  SET(EN_setdemandmodel(ph, EN_PDA, 0, 20, 0.5));
  SET(EN_setdemandmodel(ph, EN_PDA, 10, 5, 0.5));
  SET(EN_setqualtype(ph, EN_TRACE, "", "", "no such node"));
  SET(EN_setqualtype(ph, EN_AGE, "", "", ""));
  SET(EN_setqualtype(ph, EN_CHEM, "Chlorine", "mg/L", ""));
  SET(EN_setflowunits(ph, us ? EN_LPS : EN_GPM));
  SET(EN_setoption(ph, EN_PRESS_UNITS, us ? EN_METERS : EN_PSI));
  counts();
}

static void hydraulics(int initflag) {
  long t = 0, tstep = 0, left = 0;
  int e = EN_openH(ph); printf("openH %d\n", e);
  e = EN_initH(ph, initflag); printf("initH %d\n", e);
  int step = 0;
  do {
    e = EN_runH(ph, &t);
    char tag[64]; snprintf(tag, sizeof tag, "H%d@%ld", step++, t);
    printf("%s runH %d\n", tag, e);
    dynamic(tag);
    e = EN_timetonextevent(ph, &(int){0}, &left, &(int){0});
    e = EN_nextH(ph, &tstep);
    printf("%s nextH %d %ld\n", tag, e, tstep);
    if (e > 100 || step > 100000) break;
  } while (tstep > 0);
  arrays("H-end");
}

static void quality_from_file(int use_step) {
  long t = 0, tstep = 0;
  int e = EN_openQ(ph); printf("openQ %d\n", e);
  e = EN_initQ(ph, EN_NOSAVE); printf("initQ %d\n", e);
  int step = 0;
  if (!use_step) {
    do {
      e = EN_runQ(ph, &t);
      char tag[64]; snprintf(tag, sizeof tag, "Q%d@%ld", step++, t);
      printf("%s runQ %d\n", tag, e);
      quality(tag);
      e = EN_nextQ(ph, &tstep);
      printf("%s nextQ %d %ld\n", tag, e, tstep);
      if (e > 100 || step > 100000) break;
    } while (tstep > 0);
  } else {
    e = EN_runQ(ph, &t);
    printf("S runQ %d %ld\n", e, t);
    do {
      e = EN_stepQ(ph, &tstep);
      char tag[64]; snprintf(tag, sizeof tag, "S%d@%ld", step++, tstep);
      printf("%s stepQ %d\n", tag, e);
      if (step % 7 == 1) quality(tag);
      if (e > 100 || step > 100000) break;
    } while (tstep > 0);
    quality("S-end");
  }
  e = EN_closeQ(ph); printf("closeQ %d\n", e);
}

static void concurrent(void) {
  long t = 0, qt = 0, tstep = 0, qstep = 0;
  int e = EN_openH(ph); printf("C openH %d\n", e);
  e = EN_initH(ph, EN_NOSAVE); printf("C initH %d\n", e);
  e = EN_openQ(ph); printf("C openQ %d\n", e);
  e = EN_initQ(ph, EN_NOSAVE); printf("C initQ %d\n", e);
  int step = 0;
  do {
    e = EN_runH(ph, &t);
    int e2 = EN_runQ(ph, &qt);
    char tag[64]; snprintf(tag, sizeof tag, "C%d@%ld", step++, t);
    printf("%s run %d %d %ld\n", tag, e, e2, qt);
    quality(tag);
    e = EN_nextH(ph, &tstep);
    e2 = EN_nextQ(ph, &qstep);
    printf("%s next %d %ld %d %ld\n", tag, e, tstep, e2, qstep);
    if (e > 100 || e2 > 100 || step > 100000) break;
  } while (tstep > 0);
  printf("C closeQ %d closeH %d\n", EN_closeQ(ph), EN_closeH(ph));
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: probe <net.inp> [scratch-dir]\n"); return 2; }
  if (argc > 2) snprintf(scratch, sizeof scratch, "%s", argv[2]);
  char rpt[600], out[600];
  snprintf(rpt, sizeof rpt, "%s/probe.rpt", scratch);
  snprintf(out, sizeof out, "%s/probe.out", scratch);
  int version = 0; EN_getversion(&version); printf("version %d\n", version);
  char msg[EN_MAXMSG + 1];
  for (int c = 0; c <= 310; c++) {
    msg[0] = 0;
    int e = EN_geterror(c, msg, EN_MAXMSG);
    if (e == 0 && strstr(msg, "unknown") == NULL) printf("error %d %s\n", c, msg);
  }

  EN_createproject(&ph);
  printf("before-open %d %d\n", EN_getcount(ph, EN_NODECOUNT, &(int){0}), EN_openH(ph));
  int e = EN_open(ph, argv[1], rpt, out);
  printf("open %d\n", e);
  if (e > 100) { EN_deleteproject(ph); return 0; }
  counts();
  statics();
  printf("runQ-before %d\n", EN_runQ(ph, &(long){0}));

  hydraulics(EN_SAVE);
  printf("closeH %d\n", EN_closeH(ph));
  quality_from_file(0);
  quality_from_file(1);
  concurrent();
  /* Again, re-initialising flows, without saving. */
  hydraulics(EN_INITFLOW);
  printf("openQ-unsaved %d\n", EN_openQ(ph));
  printf("closeH %d\n", EN_closeH(ph));

  /* Change everything the setters reach, then read and solve again. */
  mutate();
  mutated = 1;
  statics();
  hydraulics(EN_SAVE);
  printf("closeH %d\n", EN_closeH(ph));
  quality_from_file(0);

  printf("close %d\n", EN_close(ph));
  printf("after-close %d\n", EN_getcount(ph, EN_NODECOUNT, &(int){0}));
  EN_deleteproject(ph);
  return 0;
}
