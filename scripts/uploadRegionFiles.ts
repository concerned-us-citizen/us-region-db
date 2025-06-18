import { Octokit } from "@octokit/rest";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { createReadStream, stat } from "fs";
import pkg from "../package.json" assert { type: "json" };

dotenv.config();

const TAG = `v${pkg.version}`;

if (!TAG) {
  console.error("❌ Usage: tsx uploadRegionFiles.ts <release-tag>");
  process.exit(1);
}

const FILES = ["regions.sqlite.gz", "region-names.json.gz"];

const BUILD_DIR = path.resolve("build");

const GITHUB_REPO = process.env.GITHUB_REPOSITORY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_REPO || !GITHUB_TOKEN) {
  console.error("❌ GITHUB_REPOSITORY and GITHUB_TOKEN must be set in env");
  process.exit(1);
}

const [owner, repo] = GITHUB_REPO.split("/");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function uploadAssets() {
  let release;
  try {
    release = await octokit.repos.getReleaseByTag({ owner, repo, tag: TAG });
  } catch (err) {
    if (err.status === 404) {
      console.log(`🔧 Creating release for tag ${TAG}`);
      const newRelease = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: TAG,
        name: TAG,
        draft: false,
        prerelease: false,
      });
      release = { data: newRelease.data };
    } else {
      throw err;
    }
  }

  for (const filename of FILES) {
    const fullPath = path.join(BUILD_DIR, filename);
    const stat = await fs.stat(fullPath);
    const stream = createReadStream(fullPath);

    console.log(`📤 Uploading ${filename}...`);
    // Check for existing asset
    const existingAssets = await octokit.repos.listReleaseAssets({
      owner,
      repo,
      release_id: release.data.id,
    });

    const existing = existingAssets.data.find((a) => a.name === filename);
    if (existing) {
      console.log(`🗑️ Deleting existing asset: ${filename}`);
      await octokit.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existing.id,
      });
    }

    // Upload new asset
    await octokit.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: release.data.id,
      name: filename,
      data: stream as unknown as string,
      headers: {
        "content-type": "application/gzip",
        "content-length": stat.size,
      },
    });

    console.log(`✅ Uploaded ${filename}`);
  }
}

uploadAssets().catch((err) => {
  console.error("❌ Upload failed:", err);
  process.exit(1);
});
