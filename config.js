const CONFIG = {
    // Local development: the API and the web app run separately. `npm run package` writes the production values.
    API_BASE_URL: 'http://localhost:8000',
    APP_BASE_URL: 'http://localhost:5173',
    // Public values only. Never put a Clerk secret key in the extension.
    CLERK_PUBLISHABLE_KEY: '',
    // Production uses the Clerk Frontend API origin, e.g. https://clerk.example.com.
    CLERK_SYNC_HOST: 'http://localhost'
};
