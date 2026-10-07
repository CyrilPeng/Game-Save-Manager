import semver from 'semver';
import { updateTranslations } from '../../shared/utility.js';

document.addEventListener('DOMContentLoaded', () => {
  const latestVersionSpan = document.getElementById('latest-version');
  const currentVersionSpan = document.getElementById('current-version');
  const githubLink = document.getElementById('github-link');
  const updateButton = document.getElementById('update-button');

  const fetchLatestVersion = async () => {
    const currentVersion = await window.api.invoke('get-current-version');
    currentVersionSpan.innerText = currentVersion;

    const failedMessage = await window.api.invoke(
      'translate',
      'about.load_failed',
    );
    const latestVersion = await window.api.invoke('get-latest-version');

    if (latestVersion) {
      latestVersionSpan.innerText = latestVersion;
    } else {
      latestVersionSpan.innerText = failedMessage;
      latestVersionSpan.style.color = 'red';
    }

    if (latestVersion && semver.gt(latestVersion, currentVersion)) {
      currentVersionSpan.style.color = 'red';
      latestVersionSpan.style.color = 'green';

      updateButton.classList.remove('hidden');

      const setBusy = (busy) => {
        updateButton.disabled = busy;
        updateButton.classList.toggle('cursor-not-allowed', busy);
        updateButton.classList.toggle('opacity-60', busy);
      };

      updateButton.addEventListener('click', () => {
        if (updateButton.disabled) return;
        // Keep the button disabled while opening the releases page
        setBusy(true);
        window.api.send('update-app', latestVersion);
      });
      window.api.receive('app-update-ended', () => setBusy(false));
    }
  };

  fetchLatestVersion();
  updateTranslations(document);

  githubLink.addEventListener('click', () => {
    window.api.invoke('open-url', githubLink.innerText);
  });
});
