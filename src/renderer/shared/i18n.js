export async function updateTranslations(container) {
    container.querySelectorAll("[data-i18n]").forEach(async (el) => {
        const key = el.getAttribute("data-i18n");
        const translation = await window.i18n.translate(key);
        if (translation) {

            // The element itself has .text-content
            if (el.classList.contains('text-content')) {
                el.innerText = translation;
            }

            // The element has a child that contains .text-content
            const textContentElement = el.querySelector('.text-content');
            if (textContentElement) {
                textContentElement.innerText = translation;
            }
        }
    });

    // Translate placeholders
    container.querySelectorAll('[data-i18n-placeholder]').forEach(async element => {
        const i18nKey = element.getAttribute('data-i18n-placeholder');
        element.setAttribute('placeholder', await window.i18n.translate(i18nKey));
    });
}

export function changeTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}
