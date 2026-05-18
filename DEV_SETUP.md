# Takhrij Backend Dev Setup

## Run the backend locally

1. Install dependencies:

```powershell
npm install
```

2. Copy the env example:

```powershell
Copy-Item .env.example .env
```

3. Edit `.env` and set your OpenRouter key:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
PORT=3000
```

4. Start the backend:

```powershell
npm start
```

The backend runs on `http://localhost:3000` by default.

## Connect the Expo app to local backend

In the frontend repo, create `.env.local` from `.env.local.example` and set:

```env
EXPO_PUBLIC_API_BASE_URL=http://YOUR_COMPUTER_LAN_IP:3000
```

Use your computer's LAN IP when testing on a phone. If you test only in a desktop web browser, `http://localhost:3000` can also work.

## Switch back to production

In the frontend repo, delete `.env.local` or set:

```env
EXPO_PUBLIC_API_BASE_URL=https://takhrij-backend.onrender.com
```

The backend continues to read `OPENROUTER_API_KEY` from `.env`.
