import * as shapefile from "shapefile";
import Database from "better-sqlite3";
import fs from "fs/promises";
import path from "path";
import https from "https";
import { createWriteStream, existsSync, createReadStream } from "fs";
import unzipper from "unzipper";
import simplify from "@turf/simplify";
import { promisify } from "util";
import { gzip } from "zlib";
import type { Feature, Geometry, GeoJsonProperties } from "geojson";

const censusBaseUrl = "https://www2.census.gov/geo/tiger/GENZ2020/shp/";

export const stateNameForAbbreviation: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const shapefiles = [
  {
    type: "zip",
    file: "cb_2020_us_zcta520_500k.shp",
    zip: "cb_2020_us_zcta520_500k.zip",
    getName: (props: any) => props.ZCTA5CE20,
  },
  {
    type: "city",
    file: "cb_2020_us_place_500k.shp",
    zip: "cb_2020_us_place_500k.zip",
    getName: (props: any) => props.NAME + ", " + props.STUSPS,
  },
  {
    type: "state",
    file: "cb_2020_us_state_500k.shp",
    zip: "cb_2020_us_state_500k.zip",
    getName: (props: any) => props.STUSPS,
  },
];

interface RegionRow {
  id: number;
  name: string;
  type: string;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

async function downloadAndExtract(file: string, destDir: string) {
  const url = `${censusBaseUrl}${file}`;
  const zipPath = path.join(destDir, file);
  console.log(`⬇️  Downloading ${file}...`);

  await new Promise<void>((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Failed to download ${file}: ${res.statusCode}`)
          );
        }
        const stream = createWriteStream(zipPath);
        res.pipe(stream);
        stream.on("finish", () => stream.close(() => resolve()));
      })
      .on("error", reject);
  });

  console.log(`📦 Extracting ${file}...`);
  await createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();

  await fs.unlink(zipPath);
}

export async function buildRegionDatabase() {
  const buildDir = path.resolve("build");
  const dbPath = path.join(buildDir, "regions.sqlite");
  const jsonPath = path.join(path.dirname(dbPath), "region-names.json");

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.mkdir(buildDir, { recursive: true });

  const db = new Database(dbPath);

  db.exec(`
    DROP TABLE IF EXISTS region_bounds;
    CREATE TABLE region_bounds (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      xmin REAL NOT NULL,
      ymin REAL NOT NULL,
      xmax REAL NOT NULL,
      ymax REAL NOT NULL
    );
    CREATE INDEX idx_region_name ON region_bounds(name);

    DROP TABLE IF EXISTS state_regions;
    CREATE TABLE state_regions (
      region_id INTEGER PRIMARY KEY,
      polygon_geojson TEXT NOT NULL,
      FOREIGN KEY(region_id) REFERENCES region_bounds(id)
    );
  `);

  const insert = db.prepare(
    `INSERT INTO region_bounds (id, name, type, xmin, ymin, xmax, ymax)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const fuseIndex: { id: number; name: string; type: string }[] = [];
  let id = 1;

  for (const { type, file, zip, getName } of shapefiles) {
    const filePath = path.join(buildDir, file);
    if (!existsSync(filePath)) {
      await downloadAndExtract(zip, buildDir);
    }

    const source = await shapefile.open(filePath);
    let count = 0;
    while (true) {
      if (count++ % 10 === 0) {
        console.log(`Processing ${count}`);
      }
      const result = await source.read();
      if (result.done) break;
      const { geometry, properties } = result.value;
      if (
        !geometry ||
        (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
      )
        continue;

      const name = getName(properties)?.toString().toLowerCase().trim();
      if (!name) continue;

      let coords = geometry.coordinates.flat(Infinity);
      let xmin = Infinity,
        xmax = -Infinity,
        ymin = Infinity,
        ymax = -Infinity;

      for (let i = 0; i < coords.length; i += 2) {
        const lon = coords[i];
        const lat = coords[i + 1];
        if (typeof lon !== "number" || typeof lat !== "number") continue;
        if (lon < xmin) xmin = lon;
        if (lon > xmax) xmax = lon;
        if (lat < ymin) ymin = lat;
        if (lat > ymax) ymax = lat;
      }

      if (!isFinite(xmin) || !isFinite(ymin)) continue; // skip invalid ones

      const row: RegionRow = {
        id: id,
        name,
        type,
        xmin,
        ymin,
        xmax,
        ymax,
      };

      const existing = db
        .prepare("SELECT * FROM region_bounds WHERE name = ? AND type = ?")
        .get(name, type);

      if (existing) {
        const merged = {
          xmin: Math.min(existing.xmin, row.xmin),
          ymin: Math.min(existing.ymin, row.ymin),
          xmax: Math.max(existing.xmax, row.xmax),
          ymax: Math.max(existing.ymax, row.ymax),
        };
        db.prepare(
          `UPDATE region_bounds SET xmin = ?, ymin = ?, xmax = ?, ymax = ? WHERE id = ?`
        ).run(merged.xmin, merged.ymin, merged.xmax, merged.ymax, row.id);
      } else {
        insert.run(
          row.id,
          row.name,
          row.type,
          row.xmin,
          row.ymin,
          row.xmax,
          row.ymax
        );
        fuseIndex.push({ id: row.id, name: row.name, type });

        if (type === "state") {
          // Add the full name of the state for fuzzy matching
          fuseIndex.push({
            id: row.id,
            name: stateNameForAbbreviation[row.name.toUpperCase()],
            type,
          });

          // Add simplified geometry for the states to draw boundaries and do queries
          const geojsonFeature: Feature<Geometry, GeoJsonProperties> = {
            type: "Feature",
            properties: {},
            geometry,
          };

          const simplified = simplify(geojsonFeature, {
            tolerance: 0.01, // tweak based on desired smoothing
            highQuality: false,
          });

          db.prepare(
            `INSERT INTO state_regions (region_id, polygon_geojson)
             VALUES (?, ?)`
          ).run(
            row.id,
            row.name.toUpperCase(),
            JSON.stringify(simplified.geometry)
          );
        }
        id++;
      }
    }
  }

  await fs.writeFile(jsonPath, JSON.stringify(fuseIndex, null, 2), "utf-8");
  db.close();

  console.log(`✅ Region DB written to ${dbPath}`);
  console.log(`✅ Fuse index written to ${jsonPath}`);

  const gzipAsync = promisify(gzip);

  const dbGzPath = dbPath + ".gz";
  const jsonGzPath = jsonPath + ".gz";

  const [dbBuf, jsonBuf] = await Promise.all([
    fs.readFile(dbPath),
    fs.readFile(jsonPath),
  ]);

  await Promise.all([
    fs.writeFile(dbGzPath, await gzipAsync(dbBuf)),
    fs.writeFile(jsonGzPath, await gzipAsync(jsonBuf)),
  ]);

  console.log(`✅ Gzipped files written to:
    ${dbGzPath}
    ${jsonGzPath}`);
}

if (require.main === module) {
  buildRegionDatabase().catch((err) => {
    console.error("❌ Failed to build region database:", err);
    process.exit(1);
  });
}
