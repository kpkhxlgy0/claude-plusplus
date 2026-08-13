import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const OFFICIAL_REPO = "kpkhxlgy0/claude-plusplus";

export interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface ReleaseDescriptor {
  repo: string;
  tag: string;
  version: string;
  archiveUrl: string;
  archiveName: string;
  sha256Url: string;
  releaseUrl: string;
  releaseNotes: string | null;
}

export interface ResolveReleaseOptions {
  channel: "stable" | "prerelease";
  repo: string;
}

export interface ReleaseSource {
  listReleases(repo: string): Promise<GitHubRelease[]>;
}

export async function resolveRelease(
  options: ResolveReleaseOptions,
  source: ReleaseSource | GitHubRelease[] = defaultReleaseSource,
): Promise<ReleaseDescriptor> {
  if (options.repo !== OFFICIAL_REPO) {
    throw new Error(`Stable and Prerelease updates must use the official ${OFFICIAL_REPO} repository`);
  }
  const releases = Array.isArray(source) ? source : await source.listReleases(options.repo);
  const release = releases.find((candidate) =>
    !candidate.draft && (options.channel === "prerelease" || !candidate.prerelease));
  if (!release?.tag_name) throw new Error(`No ${options.channel} release found for ${options.repo}`);
  const version = releaseVersionFromTag(release.tag_name);
  if (!version) throw new Error(`Release tag is not a supported version: ${release.tag_name}`);
  const archiveName = `claude-plusplus-${version}-win-x64.zip`;
  const archive = release.assets?.find((asset) => asset.name === archiveName);
  const checksum = release.assets?.find((asset) => asset.name === `${archiveName}.sha256`);
  if (!archive?.browser_download_url) {
    throw new Error(`Release ${release.tag_name} is missing the Windows archive asset ${archiveName}`);
  }
  if (!checksum?.browser_download_url) {
    throw new Error(`Release ${release.tag_name} is missing the checksum asset ${archiveName}.sha256`);
  }
  return {
    repo: options.repo,
    tag: release.tag_name,
    version,
    archiveUrl: archive.browser_download_url,
    archiveName,
    sha256Url: checksum.browser_download_url,
    releaseUrl: release.html_url ?? `https://github.com/${options.repo}/releases/tag/${release.tag_name}`,
    releaseNotes: typeof release.body === "string" ? release.body : null,
  };
}

export function parseReleaseChecksum(contents: string, archiveName: string): string {
  const matches = contents.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
    return match && match[2] === archiveName ? [match[1].toLowerCase()] : [];
  });
  if (matches.length !== 1) {
    throw new Error(`Checksum manifest must contain exactly one SHA-256 for ${archiveName}`);
  }
  return matches[0];
}

export function verifySha256(file: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Expected SHA-256 must contain 64 hexadecimal characters");
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${expected.toLowerCase()}, received ${actual}`);
  }
}

export function releaseVersionFromTag(tag: string): string | null {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) ? tag.replace(/^v/, "") : null;
}

const defaultReleaseSource: ReleaseSource = {
  async listReleases(repo) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": "claude-plusplus-release-client",
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Release check failed: ${response.status} ${response.statusText}`);
      return await response.json() as GitHubRelease[];
    } finally {
      clearTimeout(timeout);
    }
  },
};
