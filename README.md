# US Region Bounding Box Generator

This project pulls data for well known regions in the US from the US Census  (zipcodes, cities, and states), and builds Release artifacts for a client browser to consume: 
- regions.sqlite.gz - a compressed sqlite database containing names/region types and merged bounding boxes.
- region-names.json.gz - a compressed json file containing names/region types and db ids, suitable for fuse.js.


## File Creation

```bash
  npx tsx scripts/buildRegionFiles.ts
```

## Create Release
This will upload the file as a GitHub Release in this project with the version provided in package.json.
```
  npx tsx scripts/uploadRegionFiles.ts
```