const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// A cover's Log in link names its tab (?return=record), so logging in, or going back, lands there again.
const TABS = { record: 'Record', generate: 'Generate' };
const returnTo = TABS[params.get('return')] ? params.get('return') : null;
const home = returnTo ? `sidebar.html?mode=${returnTo}` : 'sidebar.html';
$('back-link').href = home;
if (returnTo) $('back-label').textContent = `Back to ${TABS[returnTo]}`;
const error = $('error-msg');
// mode is login or signup; opened means the website is already open in a tab.
let mode = params.get('mode') === 'signup' ? 'signup' : 'login';
let opened = params.get('opened') === '1';
const COPY = {
  login: {
    page: 'Log in', title: 'Log in', waiting: 'Finish logging in on the website', toggle: 'Need an account? Sign up',
    intro: 'Log in on the QA Ninja website with an email code or Google. This panel updates when you finish.',
    pending: 'Finish logging in on the website, then try again.'
  },
  signup: {
    page: 'Sign up', title: 'Join the Clan', waiting: 'Finish signing up on the website', toggle: 'Already have an account? Log in',
    intro: 'Create your account on the QA Ninja website with an email code or Google. This panel updates when you finish.',
    pending: 'Finish signing up on the website, then try again.'
  }
};
function render() {
  const text = COPY[mode];
  document.title = `${text.page} · QA Ninja`;
  $('form-title').textContent = opened ? text.waiting : text.title;
  $('auth-intro').textContent = opened ? 'The website is open in a new tab. When you finish there, this panel updates on its own.' : text.intro;
  $('auth-btn').textContent = opened ? 'Reopen the website' : 'Continue on website';
  $('auth-check').hidden = !opened;
  $('auth-toggle').textContent = text.toggle;
  // The URL keeps the state but never open=1, so a reload can't open a second tab.
  history.replaceState(null, '', 'login.html?' + new URLSearchParams({ mode, ...(returnTo && { return: returnTo }), ...(opened && { opened: '1' }) }));
}
async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'Please try again.');
  return response.data;
}
async function check(quiet = false) {
  try {
    const state = await request('AUTH_STATE');
    if (state.signedIn) { location.replace(home); return true; }
    if (!quiet) error.textContent = COPY[mode].pending;
  } catch (problem) { if (!quiet) error.textContent = problem.message; }
  return false;
}
async function openWebsite() {
  try { await request('SIGN_IN', { mode }); opened = true; error.textContent = ''; }
  catch (problem) { error.textContent = problem.message; }
  render();
}
$('auth-btn').onclick = openWebsite;
$('auth-check').onclick = () => check();
// Switching between log in and sign up changes the words only; the website opens when asked.
$('auth-toggle').onclick = () => { mode = mode === 'login' ? 'signup' : 'login'; opened = false; error.textContent = ''; render(); };
window.addEventListener('focus', () => check(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.auth_state?.newValue?.signedIn) location.replace(home);
});
render();
// The footer, menu, and covers link here with open=1: open the website straight away unless already signed in.
check(true).then(signedIn => { if (!signedIn && params.get('open') === '1') openWebsite(); });
