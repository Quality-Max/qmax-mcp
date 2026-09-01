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

// ---- Recorded console demo ----------------------------------------------
// Replays site/demo.cast (asciicast v2, written by `npm run demo:record`)
// into a plain <pre>. Hand-rolled on purpose: the recording carries no ANSI
// sequences, so a full terminal emulator would cost hundreds of kilobytes of
// script for nothing — and this site has to pass its own page-weight scan.
const screen = document.querySelector('[data-demo-screen]');
const playButton = document.querySelector('[data-demo-play]');
const skipButton = document.querySelector('[data-demo-skip]');
const demoStatus = document.querySelector('[data-demo-status]');

if (screen && playButton && skipButton) {
  let events = null;
  let timer = null;
  let index = 0;
  let playing = false;

  const setStatus = (label) => {
    if (demoStatus) demoStatus.textContent = label;
  };

  const loadCast = async () => {
    if (events) return events;
    const response = await fetch('demo.cast');
    if (!response.ok) throw new Error(`demo.cast: HTTP ${response.status}`);
    const lines = (await response.text()).trim().split('\n');
    events = lines.slice(1).map((line) => JSON.parse(line));
    return events;
  };

  const write = (data) => {
    screen.textContent += data.replace(/\r/g, '');
    screen.scrollTop = screen.scrollHeight;
  };

  const stop = (label) => {
    clearTimeout(timer);
    playing = false;
    playButton.textContent = index === 0 ? '▶ Play demo' : '↺ Replay';
    setStatus(label);
  };

  const scheduleNext = () => {
    if (index >= events.length) {
      stop('complete');
      return;
    }
    const [time, , data] = events[index];
    const previous = index === 0 ? 0 : events[index - 1][0];
    timer = setTimeout(() => {
      write(data);
      index += 1;
      scheduleNext();
    }, Math.min((time - previous) * 1000, 1200));
  };

  const renderAll = async () => {
    await loadCast();
    clearTimeout(timer);
    screen.textContent = '';
    for (const [, , data] of events) write(data);
    index = events.length;
    stop('complete');
  };

  const play = async () => {
    if (playing) {
      stop('paused');
      return;
    }
    try {
      await loadCast();
    } catch {
      setStatus('unavailable');
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await renderAll();
      return;
    }
    if (index >= events.length) {
      index = 0;
      screen.textContent = '';
    }
    playing = true;
    playButton.textContent = '❚❚ Pause';
    setStatus('running');
    scheduleNext();
  };

  playButton.addEventListener('click', play);
  skipButton.addEventListener('click', () => {
    renderAll().catch(() => setStatus('unavailable'));
  });
}
