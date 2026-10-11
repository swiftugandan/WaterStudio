# ADR 0010: The basemap follows the network camera; the CRS lives in [BACKDROP]

- Status: accepted
- Date: 2026-10-11

## Context

The plan calls for an OpenStreetMap basemap under the CAD canvas. EPANET coordinates are in whatever system the
modeller used (often a national grid or UTM, sometimes longitude and latitude, often none), and EPANET files have no
place for a coordinate reference system.

## Decision

- The CRS is recorded as a `CRS <EPSG code or proj4 definition>` line in [BACKDROP]. EPANET ignores [BACKDROP]
  (verified with runepanet), so files stay valid, and the model keeps it verbatim so it round-trips. It is set from
  View › Coordinates and is undoable like any edit. Coordinates that plainly are longitude and latitude get
  EPSG:4326 implicitly.
- Projections use proj4js. Common systems are built in (WGS 84, Web Mercator, every WGS 84 and ETRS89 UTM zone,
  and a handful of national grids); anything else can be given as a proj4 definition. No EPSG database is bundled.
- The network keeps drawing in its own coordinates; the camera stays the single source of truth (ADR 0008). A
  MapLibre map sits under a transparent network canvas and is moved to the centre, zoom and bearing that match the
  camera at the centre of the view, computed by probing the CRS (`geo/view.ts`). This is exact for conformal systems
  at the centre and within a pixel or two across a city, and it leaves editing, picking and the renderers untouched.
- MapLibre (and its worker, built as one of ours) is loaded only when a basemap is first shown. Tiles default to
  OpenStreetMap's raster tiles with attribution on the map; tests serve tiles locally.
- EPANET backdrop images are drawn between the basemap and the network at [BACKDROP] DIMENSIONS shifted by OFFSET.
  As in EPANET, only the file name is saved; the image itself is loaded again when needed.

## Consequences

Networks without a CRS behave as before. Reprojecting a network into another CRS, and drawing in geographic
coordinates directly, are later work; so is a vector basemap style.
