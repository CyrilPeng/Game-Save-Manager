export function wrapNumberInput(input) {
    if (!input || input.type !== 'number' || input.dataset.wrapped) return;
    input.dataset.wrapped = 'true';

    const min = input.min !== '' ? parseInt(input.min, 10) : null;
    const max = input.max !== '' ? parseInt(input.max, 10) : null;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'relative inline-flex items-center w-full';

    // Transfer margin classes from input to wrapper
    for (const cls of [...input.classList]) {
        if (cls.startsWith('mb-') || cls.startsWith('mt-') || cls.startsWith('my-')) {
            wrapper.classList.add(cls);
            input.classList.remove(cls);
        }
    }

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.add('pr-8');

    // Create controls
    const controls = document.createElement('div');
    controls.className = 'absolute right-0 top-0 bottom-0 flex flex-col w-7';
    const btnClass = 'flex-1 flex items-center justify-center cursor-pointer text-gray-400 dark:text-gray-400 text-[0.6rem] hover:text-gray-800 dark:hover:text-white active:scale-125 transition-all duration-150';
    controls.innerHTML = `
        <button type="button" tabindex="-1" data-action="increment" class="${btnClass} items-end pb-0.5 rounded-tr-lg">
            <i class="fa-solid fa-chevron-up"></i>
        </button>
        <button type="button" tabindex="-1" data-action="decrement" class="${btnClass} items-start pt-0.5 rounded-br-lg">
            <i class="fa-solid fa-chevron-down"></i>
        </button>
    `;
    wrapper.appendChild(controls);

    // Button handlers
    controls.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const current = parseInt(input.value, 10) || 0;
            let next = btn.dataset.action === 'increment' ? current + 1 : current - 1;
            if (min !== null && next < min) next = min;
            if (max !== null && next > max) next = max;
            input.value = next;
            input.dispatchEvent(new Event('input'));
        });
    });
}
