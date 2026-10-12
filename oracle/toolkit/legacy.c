/* Probe of the legacy single-precision API (epanet2.h): the same calls against
   OWA-EPANET's libepanet2 and WaterStudio's must print the same (oracle/toolkit.sh). */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "epanet2.h"

typedef struct { uint64_t h; } Hash;
static void hinit(Hash *x) { x->h = 1469598103934665603ULL; }
static void hbytes(Hash *x, const void *p, size_t n) {
  const unsigned char *b = p;
  for (size_t i = 0; i < n; i++) { x->h ^= b[i]; x->h *= 1099511628211ULL; }
}

#define SET(call) printf("set %s = %d\n", #call, (call))

static int nnodes, nlinks, npats, ncurves, ncontrols, nrules;
static float vals[200000];

static void counts(void) {
  ENgetcount(EN_NODECOUNT, &nnodes);
  ENgetcount(EN_LINKCOUNT, &nlinks);
  ENgetcount(EN_PATCOUNT, &npats);
  ENgetcount(EN_CURVECOUNT, &ncurves);
  ENgetcount(EN_CONTROLCOUNT, &ncontrols);
  ENgetcount(EN_RULECOUNT, &nrules);
  printf("counts %d %d %d %d %d %d\n", nnodes, nlinks, npats, ncurves, ncontrols, nrules);
}

/* Every node and link property, one value at a time and as arrays, hashed. */
static void values(const char *tag) {
  for (int p = 0; p <= 30; p++) {
    Hash x; hinit(&x);
    for (int i = 1; i <= nnodes; i++) {
      float v = -1; int e = ENgetnodevalue(i, p, &v);
      hbytes(&x, &e, sizeof e); if (e == 0) hbytes(&x, &v, sizeof v);
    }
    int e = (nnodes <= 200000) ? ENgetnodevalues(p, vals) : -1;
    hbytes(&x, &e, sizeof e);
    if (e == 0) hbytes(&x, vals, sizeof(float) * nnodes);
    printf("%s node.%d #%016llx\n", tag, p, (unsigned long long)x.h);
  }
  for (int p = 0; p <= 30; p++) {
    Hash x; hinit(&x);
    for (int i = 1; i <= nlinks; i++) {
      float v = -1; int e = ENgetlinkvalue(i, p, &v);
      hbytes(&x, &e, sizeof e); if (e == 0) hbytes(&x, &v, sizeof v);
    }
    int e = (nlinks <= 200000) ? ENgetlinkvalues(p, vals) : -1;
    hbytes(&x, &e, sizeof e);
    if (e == 0) hbytes(&x, vals, sizeof(float) * nlinks);
    printf("%s link.%d #%016llx\n", tag, p, (unsigned long long)x.h);
  }
  printf("%s stat", tag);
  for (int s = 0; s <= 7; s++) { float v = -1; int e = ENgetstatistic(s, &v); printf(" %d:%.9g", e, v); }
  printf("\n");
}

static void statics(void) {
  char a[EN_MAXMSG + 1], b[EN_MAXMSG + 1], c[EN_MAXMSG + 1];
  memset(a, 0, sizeof a); memset(b, 0, sizeof b); memset(c, 0, sizeof c);
  printf("title %d [%s] [%s] [%s]\n", ENgettitle(a, b, c), a, b, c);
  printf("options");
  for (int o = 0; o <= 26; o++) { float v = -1; int e = ENgetoption(o, &v); printf(" %d:%.9g", e, v); }
  printf("\ntimes");
  for (int t = 0; t < EN_NEXTEVENT; t++) { long v = -1; int e = ENgettimeparam(t, &v); printf(" %d:%ld", e, v); }
  int u = -1; printf("\nflowunits %d %d\n", ENgetflowunits(&u), u);
  int qt = -1, tn = -1; printf("qualtype %d %d %d\n", ENgetqualtype(&qt, &tn), qt, tn);
  int m = -1; float pmin = -1, preq = -1, pexp = -1;
  printf("demandmodel %d %d %.9g %.9g %.9g\n", ENgetdemandmodel(&m, &pmin, &preq, &pexp), m, pmin, preq, pexp);
  Hash x; hinit(&x);
  for (int i = 1; i <= nnodes; i++) {
    char id[EN_MAXID + 1] = ""; int t = -1, nd = -1, k = -1;
    int e = ENgetnodeid(i, id); hbytes(&x, &e, sizeof e); hbytes(&x, id, strlen(id));
    e = ENgetnodeindex(id, &k); hbytes(&x, &e, sizeof e); hbytes(&x, &k, sizeof k);
    e = ENgetnodetype(i, &t); hbytes(&x, &t, sizeof t);
    e = ENgetnumdemands(i, &nd); hbytes(&x, &nd, sizeof nd);
    for (int d = 1; d <= nd; d++) {
      float bd = -1; int pat = -1; char name[EN_MAXMSG + 1] = "";
      e = ENgetbasedemand(i, d, &bd); hbytes(&x, &e, sizeof e); hbytes(&x, &bd, sizeof bd);
      e = ENgetdemandpattern(i, d, &pat); hbytes(&x, &pat, sizeof pat);
      e = ENgetdemandname(i, d, name); hbytes(&x, name, strlen(name));
    }
    double cx = 0, cy = 0; e = ENgetcoord(i, &cx, &cy); hbytes(&x, &e, sizeof e);
    if (e == 0) { hbytes(&x, &cx, sizeof cx); hbytes(&x, &cy, sizeof cy); }
  }
  printf("nodes #%016llx\n", (unsigned long long)x.h);
  hinit(&x);
  for (int i = 1; i <= nlinks; i++) {
    char id[EN_MAXID + 1] = ""; int t = -1, n1 = -1, n2 = -1, nv = -1;
    int e = ENgetlinkid(i, id); hbytes(&x, &e, sizeof e); hbytes(&x, id, strlen(id));
    e = ENgetlinktype(i, &t); hbytes(&x, &t, sizeof t);
    e = ENgetlinknodes(i, &n1, &n2); hbytes(&x, &n1, sizeof n1); hbytes(&x, &n2, sizeof n2);
    e = ENgetvertexcount(i, &nv); hbytes(&x, &nv, sizeof nv);
    if (t == EN_PUMP) {
      int pt = -1, hc = -1;
      e = ENgetpumptype(i, &pt); hbytes(&x, &e, sizeof e); hbytes(&x, &pt, sizeof pt);
      e = ENgetheadcurveindex(i, &hc); hbytes(&x, &hc, sizeof hc);
    }
  }
  printf("links #%016llx\n", (unsigned long long)x.h);
  for (int i = 1; i <= npats; i++) {
    char id[EN_MAXID + 1] = ""; int len = -1; float av = -1;
    ENgetpatternid(i, id); ENgetpatternlen(i, &len);
    int e = ENgetaveragepatternvalue(i, &av);
    printf("pattern %d %s %d %d:%.9g", i, id, len, e, av);
    for (int k = 1; k <= len && k <= 30; k++) { float v = -1; ENgetpatternvalue(i, k, &v); printf(" %.9g", v); }
    printf("\n");
  }
  for (int i = 1; i <= ncurves; i++) {
    char id[EN_MAXID + 1]; int n = -1, t = -1;
    memset(id, 0, sizeof id);
    int e = ENgetcurve(i, id, &n, vals, vals + 100000);
    ENgetcurvetype(i, &t);
    printf("curve %d %d %s %d type %d", i, e, id, n, t);
    for (int k = 0; k < n && k < 30; k++) printf(" %.9g,%.9g", vals[k], vals[100000 + k]);
    float cx = -1, cy = -1; e = ENgetcurvevalue(i, 1, &cx, &cy);
    printf(" | %d %.9g %.9g\n", e, cx, cy);
  }
  for (int i = 1; i <= ncontrols; i++) {
    int t = -1, l = -1, n = -1, en = -1; float s = -1, lv = -1;
    int e = ENgetcontrol(i, &t, &l, &s, &n, &lv);
    ENgetcontrolenabled(i, &en);
    printf("control %d %d: %d %d %.9g %d %.9g %d\n", i, e, t, l, s, n, lv, en);
  }
  for (int i = 1; i <= nrules; i++) {
    int np = -1, nt = -1, ne = -1; float pr = -1; char id[EN_MAXID + 1] = "";
    int e = ENgetrule(i, &np, &nt, &ne, &pr);
    ENgetruleID(i, id);
    printf("rule %d %d %s %d %d %d %.9g", i, e, id, np, nt, ne, pr);
    for (int k = 1; k <= np; k++) {
      int lo, ob, oi, va, re, st; float v = -1;
      e = ENgetpremise(i, k, &lo, &ob, &oi, &va, &re, &st, &v);
      printf(" P%d:%d %d %d %d %d %d %d %.9g", k, e, lo, ob, oi, va, re, st, v);
    }
    for (int k = 1; k <= nt; k++) {
      int li, st; float s = -1; e = ENgetthenaction(i, k, &li, &st, &s);
      printf(" T%d:%d %d %d %.9g", k, e, li, st, s);
    }
    for (int k = 1; k <= ne; k++) {
      int li, st; float s = -1; e = ENgetelseaction(i, k, &li, &st, &s);
      printf(" E%d:%d %d %d %.9g", k, e, li, st, s);
    }
    printf("\n");
  }
}

static void hydraulics(void) {
  long t = 0, tstep = 0;
  int eo = ENopenH();
  int ei = ENinitH(EN_SAVE);
  printf("openH %d initH %d\n", eo, ei);
  int step = 0;
  do {
    int e = ENrunH(&t);
    char tag[64]; snprintf(tag, sizeof tag, "H%d@%ld", step++, t);
    printf("%s runH %d\n", tag, e);
    if (e <= 100) values(tag);
    e = ENnextH(&tstep);
    printf("%s nextH %d %ld\n", tag, e, tstep);
    if (e > 100 || step > 100000) break;
  } while (tstep > 0);
  printf("closeH %d\n", ENcloseH());
}

static void quality(void) {
  long t = 0, tstep = 0;
  int eo = ENopenQ();
  int ei = ENinitQ(EN_NOSAVE);
  printf("openQ %d initQ %d\n", eo, ei);
  int step = 0;
  do {
    int e = ENrunQ(&t);
    char tag[64]; snprintf(tag, sizeof tag, "Q%d@%ld", step++, t);
    printf("%s runQ %d\n", tag, e);
    if (e <= 100) {
      float v = -1; Hash x; hinit(&x);
      for (int i = 1; i <= nnodes; i++) { ENgetnodevalue(i, EN_QUALITY, &v); hbytes(&x, &v, sizeof v); }
      printf("%s quality #%016llx\n", tag, (unsigned long long)x.h);
    }
    e = ENnextQ(&tstep);
    if (e > 100 || step > 100000) break;
  } while (tstep > 0);
  printf("closeQ %d\n", ENcloseQ());
}

int main(int argc, char **argv) {
  char scratch[512] = ".", rpt[600], out[600], inp[600];
  if (argc < 2) { fprintf(stderr, "usage: legacy <net.inp> [scratch-dir]\n"); return 2; }
  if (argc > 2) snprintf(scratch, sizeof scratch, "%s", argv[2]);
  int v = 0; ENgetversion(&v); printf("version %d\n", v);
  char msg[EN_MAXMSG + 1] = ""; ENgeterror(110, msg, EN_MAXMSG); printf("error [%s]\n", msg);
  printf("before-open %d\n", ENgetcount(EN_NODECOUNT, &(int){0}));

  snprintf(rpt, sizeof rpt, "%s/legacy.rpt", scratch);
  snprintf(out, sizeof out, "%s/legacy.out", scratch);
  int e = ENopen(argv[1], rpt, out);
  printf("open %d\n", e);
  if (e > 100) return 0;
  counts();
  statics();
  /* (Running without ENinitH, after an ENinitH before ENopenH, reads uninitialised
     memory in the reference and crashes it on some networks.) */
  hydraulics();
  quality();

  /* The setters, with single-precision values. */
  SET(ENsetnodevalue(1, EN_ELEVATION, 123.25f));
  SET(ENsetlinkvalue(1, EN_DIAMETER, 7.5f));
  SET(ENsetoption(EN_DEMANDMULT, 1.1f));
  SET(ENsetjuncdata(1, 99.5f, 3.25f, ""));
  SET(ENsetpipedata(nlinks, 1000.5f, 9.75f, 110.0f, 0.25f));
  float pv[] = {0.5f, 1.25f, 1.75f};
  SET(ENaddpattern("LegacyP"));
  SET(ENsetpattern(npats + 1, pv, 3));
  SET(ENsetpattern(npats + 1, NULL, 3));
  SET(ENsetpatternvalue(npats + 1, 2, 2.5f));
  float cx[] = {0.0f, 50.0f, 100.0f}, cy[] = {80.0f, 60.0f, 20.0f};
  SET(ENaddcurve("LegacyC"));
  SET(ENsetcurve(ncurves + 1, cx, cy, 3));
  SET(ENsetcurve(ncurves + 1, cx, cy, 0));
  SET(ENsetcurvevalue(ncurves + 1, 2, 55.5f, 58.25f));
  SET(ENsetdemandmodel(EN_PDA, 1.0f, 25.0f, 0.5f));
  SET(ENsetbasedemand(1, 1, 4.75f));
  SET(ENadddemand(1, 2.5f, "LegacyP", "extra"));
  SET(ENaddcontrol(EN_TIMER, 1, 0.0f, 0, 3600.0f, &e));
  if (ncontrols + 1 <= 1000) SET(ENsetcontrol(ncontrols + 1, EN_TIMER, 1, 1.0f, 0, 7200.0f));
  counts();
  statics();
  hydraulics();
  quality();
  snprintf(inp, sizeof inp, "%s/legacy.inp", scratch);
  SET(ENsaveinpfile(inp));
  SET(ENsolveH());
  SET(ENsolveQ());
  SET(ENreport());
  printf("close %d after %d\n", ENclose(), ENgetcount(EN_NODECOUNT, &(int){0}));

  /* A whole run to files. */
  snprintf(rpt, sizeof rpt, "%s/legacy-run.rpt", scratch);
  snprintf(out, sizeof out, "%s/legacy-run.out", scratch);
  printf("epanet %d\n", ENepanet(argv[1], rpt, out, NULL));
  return 0;
}
