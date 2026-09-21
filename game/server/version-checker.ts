import fetch from 'node-fetch';

const RELEASES_URL = 'https://api.github.com/repos/itschip/screencapture/releases';
const CHECK_TIMEOUT_MS = 10000;

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

function getResourceVersion(): string | undefined {
  try {
    return GetResourceMetadata(GetCurrentResourceName(), 'version', 0) || undefined;
  } catch {
    return undefined;
  }
}

function parseVersion(version: string | undefined): ParsedVersion | undefined {
  const match = version?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function isNewerVersion(remote: ParsedVersion, current: ParsedVersion): boolean {
  if (remote.major !== current.major) return remote.major > current.major;
  if (remote.minor !== current.minor) return remote.minor > current.minor;
  if (remote.patch !== current.patch) return remote.patch > current.patch;

  return !remote.prerelease && Boolean(current.prerelease);
}

function isStableRelease(release: GitHubRelease): release is GitHubRelease & { tag_name: string } {
  if (!release.tag_name || release.draft || release.prerelease) return false;
  return !release.tag_name.toLowerCase().includes('beta');
}

function findLatestStableRelease(releases: GitHubRelease[]): GitHubRelease | undefined {
  return releases.find(isStableRelease);
}

export async function checkForUpdates(): Promise<void> {
  const currentVersionText = getResourceVersion();
  const currentVersion = parseVersion(currentVersionText);

  if (!currentVersion) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'screencapture-fivem-version-checker',
      },
      signal: controller.signal,
    });

    if (!response.ok) return;

    const releases = (await response.json()) as GitHubRelease[];
    const latestRelease = findLatestStableRelease(releases);
    const latestVersion = parseVersion(latestRelease?.tag_name);

    if (!latestRelease || !latestVersion || !isNewerVersion(latestVersion, currentVersion)) return;

    console.warn(
      `[screencapture] A newer stable version is available: ${latestRelease.tag_name} (current: ${currentVersionText}). ${latestRelease.html_url || 'https://github.com/itschip/screencapture/releases'}`,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
  } finally {
    clearTimeout(timeout);
  }
}