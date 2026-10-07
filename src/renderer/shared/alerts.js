import { updateTranslations } from './i18n.js';
export async function showAlert(type, message, modalContent) {
  const alertContainer = document.getElementById('alert-container');

  const alertClasses = {
    info: 'text-blue-800 bg-blue-50 dark:bg-gray-800 dark:text-blue-400',
    error: 'text-red-800 bg-red-50 dark:bg-gray-800 dark:text-red-400',
    success: 'text-green-800 bg-green-50 dark:bg-gray-800 dark:text-green-400',
    warning:
      'text-yellow-800 bg-yellow-50 dark:bg-gray-800 dark:text-yellow-300',
    modal: 'text-red-800 bg-red-50 dark:bg-gray-800 dark:text-red-400',
  };
  if (!Object.prototype.hasOwnProperty.call(alertClasses, type)) type = 'info';

  const iconPaths = {
    info: 'M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z',
    error:
      'M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z',
    success:
      'M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z',
    warning:
      'M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z',
    modal:
      'M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z',
  };

  const alertElement = document.createElement('div');
  alertElement.className = `flex ml-auto max-w-max items-center p-4 mb-2 rounded-lg ${alertClasses[type]} animate-fadeInShift`;

  alertElement.innerHTML = `
        <svg class="shrink-0 w-4 h-4" aria-hidden="true" fill="currentColor"
            viewBox="0 0 20 20">
            <path
                d="${iconPaths[type]}" />
        </svg>
        <span class="sr-only">${type.charAt(0).toUpperCase() + type.slice(1)}</span>
        <div class="ms-3 text-sm font-medium">
            <span class="text-content alert-message"></span>
        </div>
    `;

  if (type === 'modal') {
    alertElement.innerHTML += `
            <button type="button" class="ms-2 text-blue-500 text-sm font-medium underline" data-i18n="alert.learn_more">
                <span class="text-content">Learn More</span>
            </button>
        `;

    alertElement.querySelector('button').addEventListener('click', () => {
      showInfoModal(message, modalContent);
    });
  } else {
    alertElement.innerHTML += `
            <button type="button"
                class="ms-auto -mx-1.5 -my-1.5 rounded-lg p-1.5 inline-flex items-center justify-center h-8 w-8 hover:bg-opacity-75"
                aria-label="Close">
                <span class="sr-only">Close</span>
                <svg class="w-3 h-3" aria-hidden="true" fill="none"
                    viewBox="0 0 14 14">
                    <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6" />
                </svg>
            </button>
        `;

    // Handle manual close
    alertElement.querySelector('button').addEventListener('click', () => {
      alertElement.classList.replace(
        'animate-fadeInShift',
        'animate-fadeOutShift',
      );
      alertElement.addEventListener('animationend', () => {
        alertElement.remove();
      });
    });
  }

  alertElement.querySelector('.alert-message').textContent = message;
  alertContainer.appendChild(alertElement);
  updateTranslations(alertElement);

  // Handle automatic removal after 5 seconds
  setTimeout(() => {
    alertElement.classList.replace(
      'animate-fadeInShift',
      'animate-fadeOutShift',
    );
    alertElement.addEventListener('animationend', () => {
      alertElement.remove();
    });
  }, 5000);
}

// Info modal, showing either "ok" or "yesno" style
export async function showInfoModal(modalTitle, modalContent, style = 'ok') {
  return new Promise(async (resolve) => {
    const modal = document.getElementById('modal-info');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitleElement = document.getElementById('modal-info-title');
    const modalContentElement = document.getElementById('modal-info-content');
    const closeButton = document.getElementById('modal-info-close');
    const noButton = document.getElementById('modal-info-no');
    const confirmButton = document.getElementById('modal-info-confirm');

    modalTitleElement.textContent = modalTitle;

    // Handle mixed content: strings as plain text, arrays as list items
    if (Array.isArray(modalContent)) {
      const contentElements = modalContent.map((item) => {
        if (Array.isArray(item)) {
          const list = document.createElement('ul');
          list.className = 'list-disc list-inside ml-3';
          for (const listItem of item) {
            const entry = document.createElement('li');
            entry.textContent = listItem;
            list.append(entry);
          }
          return list;
        } else {
          const paragraph = document.createElement('p');
          paragraph.textContent = item;
          return paragraph;
        }
      });
      modalContentElement.replaceChildren(...contentElements);
    } else {
      modalContentElement.textContent = modalContent;
    }

    const closeModal = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modalOverlay.classList.add('hidden');
      cleanupListeners();
    };

    const cleanupListeners = () => {
      closeButton.removeEventListener('click', handleClose);
      noButton.removeEventListener('click', handleNo);
      confirmButton.removeEventListener('click', handleConfirm);
    };

    const handleClose = () => {
      closeModal();
      if (style === 'yesno') {
        resolve(false);
      } else {
        resolve(true);
      }
    };

    const handleNo = () => {
      closeModal();
      resolve(false);
    };

    const handleConfirm = () => {
      closeModal();
      resolve(true);
    };

    if (style === 'yesno') {
      noButton.style.display = '';
      noButton.textContent = await window.i18n.translate('alert.no');
      confirmButton.textContent = await window.i18n.translate('alert.yes');
    } else {
      noButton.style.display = 'none';
      confirmButton.textContent = 'Ok';
    }

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    closeButton.addEventListener('click', handleClose);
    noButton.addEventListener('click', handleNo);
    confirmButton.addEventListener('click', handleConfirm);
  });
}

// ======================================================================
// Export and import
// ======================================================================
// Export modal
