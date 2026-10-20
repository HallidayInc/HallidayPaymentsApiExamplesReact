# Halliday API Examples with React

Halliday Payments API integration examples using React. This project uses the Vite React template. The Halliday API is accessed over HTTP directly without using the SDK. Swaps, retries, and withdrawals can be done by connecting an EIP-1193 wallet like MetaMask or Rabby. Ethers.js 6 is used for wallet interactions.

### Keys

Get a Halliday API key from the Halliday Dashboard: https://dashboard.halliday.xyz

### Run

Create an `.env` file and supplant Halliday API key. See `.env.example`.

```
VITE_HALLIDAY_API_KEY=_your_api_key_here_
```

Run the app using the command line:

```
npm install
npm run dev
```