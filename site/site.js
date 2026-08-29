const copyButtons = document.querySelectorAll('[data-copy]');
const toast = document.querySelector('.copy-toast');
let toastTimer;

copyButtons.forEach((copyButton) => {
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copy);
      toast.textContent = 'Copied to clipboard';
    } catch {
      toast.textContent = 'Copy failed — select the command';
    }

    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
  });
});
