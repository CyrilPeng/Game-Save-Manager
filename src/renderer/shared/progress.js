export function updateProgress(progressId, progressTitle, percentage) {
  const progressContainer = document.getElementById('progress-container');

  if (percentage === 'start') {
    const progressElement = document.createElement('div');
    progressElement.id = progressId;
    progressElement.className =
      'ml-auto max-w-max p-4 mb-2 rounded-lg bg-blue-50 dark:bg-gray-800 animate-fadeIn';
    progressElement.innerHTML = `
            <div class="flex justify-between mb-1 text-sm font-medium text-blue-700 dark:text-white">
                <span class="progress-title"></span>
                <span class="progress-percentage">0%</span>
            </div>
            <div class="w-60 bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
                <div class="progress-bar bg-blue-600 w-0 h-2.5 rounded-full"></div>
            </div>
        `;

    progressElement.querySelector('.progress-title').textContent =
      progressTitle;
    progressElement.querySelector('.progress-percentage').id =
      `${progressId}-percentage`;
    progressElement.querySelector('.progress-bar').id = `${progressId}-bar`;
    progressContainer.appendChild(progressElement);
    return;
  } else if (percentage === 'end') {
    const progressElement = document.getElementById(progressId);
    if (progressElement) progressElement.remove();
    return;
  }

  const progressBar = document.getElementById(`${progressId}-bar`);
  const progressPercentage = document.getElementById(
    `${progressId}-percentage`,
  );
  if (!progressBar || !progressPercentage) return;
  percentage = Math.max(0, Math.min(100, Number(percentage) || 0));
  progressBar.style.width = `${percentage}%`;
  progressPercentage.innerText = `${percentage}%`;
}

// ======================================================================
// Account details
