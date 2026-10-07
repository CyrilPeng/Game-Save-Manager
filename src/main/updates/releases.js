const axios = require('axios');
const semver = require('semver');
const project = require('../../project');

/** Stable installations ignore prereleases; beta installations can receive both. */
function selectRelease(releases, currentVersion) {
  const includePrereleases = !!semver.prerelease(currentVersion);
  return (
    releases
      .filter(
        (release) =>
          !release.draft && (includePrereleases || !release.prerelease),
      )
      .map((release) => ({
        ...release,
        version: semver.valid(release.tag_name),
      }))
      .filter(
        (release) =>
          release.version &&
          (includePrereleases || !semver.prerelease(release.version)),
      )
      .filter(
        (release) =>
          typeof release.html_url === 'string' &&
          release.html_url.startsWith(project.releasesUrl + '/tag/'),
      )
      .sort((a, b) => semver.rcompare(a.version, b.version))[0] || null
  );
}

function createReleaseClient({ currentVersion, request = axios.get } = {}) {
  return {
    async latest() {
      const response = await request(project.releaseApiUrl, {
        timeout: 15000,
        headers: { Accept: 'application/vnd.github+json' },
        params: { per_page: 100 },
      });
      if (!Array.isArray(response.data))
        throw new Error('Invalid release response');
      return selectRelease(response.data, currentVersion);
    },
  };
}
module.exports = { selectRelease, createReleaseClient };
