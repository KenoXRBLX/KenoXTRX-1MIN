const { Telegraf, Markup, session } = require('telegraf');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const logging = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  warning: (msg) => console.log(`[WARN] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.log(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`)
};

const BOT_TOKEN = "8646543959:AAG2Jbp-3izB78xfZuw9jKXeF3WSHLLDi6w";
const ADMIN_ID = 7915159454;
const BASE_URL = "https://ckygjf6r.com/api/webapi/";
const TRX_HISTORY_URL = "https://draw.ar-lottery01.com/TrxWinGo/TrxWinGo_1M/GetHistoryIssuePage.json";
const WIN_LOSE_CHECK_INTERVAL = 2;
const MAX_RESULT_WAIT_TIME = 60;
const MAX_BALANCE_RETRIES = 10;
const BALANCE_RETRY_DELAY = 5;
const BALANCE_API_TIMEOUT = 20000;
const BET_API_TIMEOUT = 30000;
const MAX_BET_RETRIES = 3;
const BET_RETRY_DELAY = 5;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_TELEGRAM_RETRIES = 3;
const TELEGRAM_RETRY_DELAY = 2000;
const DEFAULT_BS_ORDER = "BSBBSBSSSB";
const VIRTUAL_BALANCE = 1135612.26;
const MIN_AI_PREDICTION_DATA = 5;
const HISTORY_BUFFER_SIZE = 20;
const KENNO_REQUIRED = 11;
const KENNO_V2_REQUIRED = 1;
const KENNO_MAX_REQUIRED = 2;

const userState = {};
const userTemp = {};
const userSessions = {};
const userSettings = {};
const userPendingBets = {};
const userWaitingForResult = {};
const userStats = {};
const userGameInfo = {};
const userSkippedBets = {};
const userShouldSkipNext = {};
const userBalanceWarnings = {};
const userSkipResultWait = {};
const userAILast10Results = [];
const userAIRoundCount = {};
const userStopInitiated = {};
const userSLSkipWaitingForWin = {};
const userKennoMaxHits = {};
const userKennoMaxConsecLosses = {};
let allowedcklotteryIds = new Set();

const KENNO_FILE = path.join(process.cwd(), 'data', 'kenno_results.json');

function ensureDataDir() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function loadKENNOResults() {
  try {
    ensureDataDir();
    if (fs.existsSync(KENNO_FILE)) {
      const data = JSON.parse(fs.readFileSync(KENNO_FILE, 'utf8'));
      return data.results || [];
    }
  } catch (error) {
    logging.error(`KENNO load error: ${error.message}`);
  }
  return [];
}

function saveKENNOResults(results) {
  try {
    ensureDataDir();
    fs.writeFileSync(KENNO_FILE, JSON.stringify({
      results: results,
      lastUpdated: Date.now()
    }, null, 2));
  } catch (error) {
    logging.error(`KENNO save error: ${error.message}`);
  }
}

async function initKENNOResults() {
  try {
    const url = `${TRX_HISTORY_URL}?ts=${Date.now()}`;
    const response = await makeRequest(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });

    if (response.data?.code === 0 && response.data.data?.list) {
      const results = response.data.data.list.map(item => ({
        issueNumber: item.issueNumber,
        number: String(item.number)
      }));
      saveKENNOResults(results);
      logging.info(`KENNO: Initialized ${results.length} results (need ${KENNO_REQUIRED})`);
      return true;
    }
    return false;
  } catch (error) {
    logging.error(`KENNO init error: ${error.message}`);
    return false;
  }
}

function addKENNOResult(issueNumber, number) {
  let results = loadKENNOResults();

  if (results.length > 0 && results[0].issueNumber === issueNumber) {
    return results.length;
  }

  results.unshift({ issueNumber, number: String(number) });

  if (results.length > KENNO_REQUIRED) {
    results = results.slice(0, KENNO_REQUIRED);
  }

  saveKENNOResults(results);

  const bsString = results.map(r => parseInt(r.number) >= 5 ? 'B' : 'S').join('');
  logging.info(`KENNO: Added #${number}, total: ${results.length}/${KENNO_REQUIRED}`);
  logging.info(`KENNO: ${bsString}`);

  return results.length;
}

function getKENNOPrediction() {
  const results = loadKENNOResults();

  if (results.length < KENNO_REQUIRED) {
    logging.warning(`KENNO: ${results.length}/${KENNO_REQUIRED} results`);
    return null;
  }

  const kenno = results[10];
  const number = parseInt(kenno.number || '0') % 10;
  const bigSmall = number >= 5 ? 'B' : 'S';

  const bsString = results.map(r => parseInt(r.number) >= 5 ? 'B' : 'S').join('');
  logging.info(`KENNO: [${bsString}] = ${bigSmall === 'B' ? 'BIG' : 'SMALL'}`);

  return {
    result: bigSmall,
    issueNumber: kenno.issueNumber,
    number: number,
    totalResults: results.length,
    pattern: bsString
  };
}

function getKENNOV2Prediction() {
  const results = loadKENNOResults();

  if (results.length < 3) {
    logging.warning(`KENNO V2: Need 3 results, have ${results.length}`);
    return null;
  }

  const num1 = parseInt(results[0].number || '0') % 10;
  const num2 = parseInt(results[1].number || '0') % 10;
  const num3 = parseInt(results[2].number || '0') % 10;

  const weightedSum = (num1 * 0.5) + (num2 * 0.3) + (num3 * 0.2);
  const bigSmall = weightedSum >= 5 ? 'B' : 'S';

  logging.info(`KENNO V2: [${num1}x0.5 + ${num2}x0.3 + ${num3}x0.2 = ${weightedSum.toFixed(2)}] => ${bigSmall === 'B' ? 'BIG' : 'SMALL'}`);

  return {
    result: bigSmall,
    weightedSum: weightedSum,
    num1: num1,
    num2: num2,
    num3: num3,
    issueNumber: results[0].issueNumber,
    totalResults: results.length
  };
}

function getKENNOMaxPrediction() {
  const results = loadKENNOResults();

  if (results.length < KENNO_MAX_REQUIRED) {
    logging.warning(`KENNO MAX: Need ${KENNO_MAX_REQUIRED} results, have ${results.length}`);
    return null;
  }

  const latest = results[0];
  const issueNumber = String(latest.issueNumber);
  const lastTwoDigits = parseInt(issueNumber.slice(-2));
  const nextTwoDigits = lastTwoDigits + 1;

  if (nextTwoDigits % 3 !== 0) {
    logging.info(`KENNO MAX: next=${nextTwoDigits} => NOT divisible by 3, skip`);
    return { skip: true };
  }

  const num1 = parseInt(latest.number || '0') % 10;
  const second = results[1];
  const num2 = parseInt(second.number || '0') % 10;
  
  // Keep adding digits until single digit
  let sum = num1 + num2;
  while (sum >= 10) {
    sum = String(sum).split('').reduce((a, b) => a + parseInt(b), 0);
  }

  const rawResult = sum >= 5 ? 'B' : 'S';
  const betResult = rawResult === 'B' ? 'S' : 'B';

  logging.info(`KENNO MAX: [${num2}+${num1}=>${sum}] => Bet ${betResult === 'B' ? 'BIG' : 'SMALL'}`);

  return {
    result: betResult,
    sum: sum,
    num1: num1,
    num2: num2,
    issueNumber: latest.issueNumber,
    totalResults: results.length,
    skip: false
  };
}

async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      keepAliveMsecs: 1000
    });

    const defaultOptions = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
        'Connection': 'Keep-Alive',
        'Ar-Origin': 'https://www.cklottery.online',
        'Origin': 'https://www.cklottery.online',
        'Referer': 'https://www.cklottery.online',
      },
      timeout: 12000
    };

    const requestOptions = { ...defaultOptions, ...options, agent };
    const req = https.request(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ data: JSON.parse(data) }); }
        catch (error) { reject(new Error(`Parse error: ${error.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function loadAllowedUsers() {
  try {
    ensureDataDir();
    const filePath = path.join(process.cwd(), 'data', 'users_cklottery.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      allowedcklotteryIds = new Set(data.allowed_ids || []);
      logging.info(`Loaded ${allowedcklotteryIds.size} users`);
    } else {
      allowedcklotteryIds = new Set();
      saveAllowedUsers();
    }
  } catch (error) {
    logging.error(`Error loading users: ${error}`);
    allowedcklotteryIds = new Set();
  }
}

function saveAllowedUsers() {
  try {
    ensureDataDir();
    fs.writeFileSync(path.join(process.cwd(), 'data', 'users_cklottery.json'), JSON.stringify({ allowed_ids: Array.from(allowedcklotteryIds) }, null, 4));
  } catch (error) {
    logging.error(`Error saving users: ${error}`);
  }
}

function normalizeText(text) { return text.normalize('NFKC').trim(); }

function generateSignature(data) {
  const f = {};
  const exclude = ["signature", "track", "xosoBettingData"];
  Object.keys(data).sort().forEach(function(k) {
    const v = data[k];
    if (v !== null && v !== '' && !exclude.includes(k)) { f[k] = v === 0 ? 0 : v; }
  });
  return crypto.createHash('md5').update(JSON.stringify(f)).digest('hex').toUpperCase();
}

function computeUnitAmount(amt) {
  if (amt <= 0) return 1;
  const amtStr = String(amt);
  const zeros = amtStr.length - amtStr.replace(/0+$/, '').length;
  if (zeros >= 4) return 10000;
  if (zeros === 3) return 1000;
  if (zeros === 2) return 100;
  if (zeros === 1) return 10;
  return Math.pow(10, amtStr.length - 1);
}

function getSelectMap() { return { "B": 13, "S": 14 }; }

async function getAIPrediction(userId) {
  try {
    if (!userAILast10Results[userId]) userAILast10Results[userId] = [];
    if (!userAIRoundCount[userId]) userAIRoundCount[userId] = 0;
    userAIRoundCount[userId]++;
    if (userAILast10Results[userId].length <= 10) {
      return { result: Math.random() < 0.5 ? 'B' : 'S', percent: '50.0' };
    }
    const lastTen = userAILast10Results[userId].slice(-10);
    const counts = { B: 0, S: 0 };
    for (const r of lastTen) counts[r]++;
    const last3 = lastTen.slice(-3).join('');
    if (last3 === 'BBB') return { result: 'S', percent: '70.0' };
    if (last3 === 'SSS') return { result: 'B', percent: '70.0' };
    if (counts.B > counts.S) return { result: 'B', percent: '50.0' };
    if (counts.S > counts.B) return { result: 'S', percent: '50.0' };
    return { result: Math.random() < 0.5 ? 'B' : 'S', percent: '50.0' };
  } catch (error) {
    return { result: 'B', percent: '50.0' };
  }
}

function getValidDalembertBetAmount(unitSize, currentUnits, balance, minBet) {
  let amount = unitSize * currentUnits;
  while (amount > balance && currentUnits > 1) { currentUnits--; amount = unitSize * currentUnits; }
  if (amount > balance) amount = balance;
  if (amount < minBet) amount = minBet;
  return { amount, adjustedUnits: currentUnits };
}

function computeBetDetails(desiredAmount) {
  if (desiredAmount <= 0) return { unitAmount: 0, betCount: 0, actualAmount: 0 };
  const unitAmount = computeUnitAmount(desiredAmount);
  const betCount = Math.max(1, Math.floor(desiredAmount / unitAmount));
  return { unitAmount, betCount, actualAmount: unitAmount * betCount };
}

function calculateBetAmount(settings, currentBalance) {
  const bettingStrategy = settings.betting_strategy || "Martingale";
  const betSizes = settings.bet_sizes || [100];
  const minBetSize = Math.min(...betSizes.filter(b => typeof b === 'number'));
  if (bettingStrategy === "D'Alembert") {
    if (betSizes.length > 1) throw new Error("D'Alembert requires only ONE bet size");
    const unitSize = betSizes[0];
    let units = settings.dalembert_units || 1;
    const { amount, adjustedUnits } = getValidDalembertBetAmount(unitSize, units, currentBalance, minBetSize);
    if (adjustedUnits !== units) { settings.dalembert_units = adjustedUnits; }
    return amount;
  } else if (bettingStrategy === "Custom") {
    return betSizes[Math.min(settings.custom_index || 0, betSizes.length - 1)];
  } else {
    return betSizes[Math.min(settings.martin_index || 0, betSizes.length - 1)];
  }
}

function updateBettingStrategy(settings, isWin, betAmount, rawBetItem) {
  const bettingStrategy = settings.betting_strategy || "Martingale";
  const betSizes = settings.bet_sizes || [100];
  const comparisonValue = rawBetItem !== undefined ? rawBetItem : betAmount;

  if (bettingStrategy === "Martingale") {
    settings.martin_index = isWin ? 0 : Math.min((settings.martin_index || 0) + 1, betSizes.length - 1);
  } else if (bettingStrategy === "Anti-Martingale") {
    settings.martin_index = isWin ? Math.min((settings.martin_index || 0) + 1, betSizes.length - 1) : 0;
  } else if (bettingStrategy === "D'Alembert") {
    settings.dalembert_units = isWin ? Math.max(1, (settings.dalembert_units || 1) - 1) : (settings.dalembert_units || 1) + 1;
  } else if (bettingStrategy === "Custom") {
    let actualIndex = 0;
    for (let i = 0; i < betSizes.length; i++) {
      if (betSizes[i] === comparisonValue) { actualIndex = i; break; }
    }
    if (isWin) settings.custom_index = actualIndex > 0 ? actualIndex - 1 : 0;
    else settings.custom_index = actualIndex < betSizes.length - 1 ? actualIndex + 1 : betSizes.length - 1;
  }
}

async function loginRequest(phone, password) {
  const body = { phonetype: -1, language: 0, logintype: "mobile", random: "9078efc98754430e92e51da59eb2563c", username: "95" + phone, pwd: password };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  try {
    const response = await makeRequest(BASE_URL + "Login", { method: 'POST', body });
    const res = response.data;
    if (res.code === 0 && res.data) {
      const tokenHeader = res.data.tokenHeader || "Bearer ";
      const token = res.data.token || "";
      const session = { post: async (endpoint, data) => makeRequest(BASE_URL + endpoint, { method: 'POST', headers: { "Authorization": `${tokenHeader}${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: data }) };
      return { response: res, session };
    }
    return { response: res, session: null };
  } catch (error) { return { response: { error: error.message }, session: null }; }
}

async function getUserInfo(session, userId) {
  const body = { language: 0, random: "9078efc98754430e92e51da59eb2563c" };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  try {
    const response = await session.post("GetUserInfo", body);
    const res = response.data;
    if (res.code === 0 && res.data) {
      const info = { user_id: res.data.userId, username: res.data.userName, nickname: res.data.nickName, balance: res.data.amount };
      userGameInfo[userId] = info;
      return info;
    }
    return null;
  } catch (error) { return null; }
}

async function getBalance(session, userId) {
  const body = { language: 0, random: "9078efc6f3794bf49f257d07937d1a29" };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  try {
    const response = await session.post("GetBalance", body);
    const res = response.data;
    if (res.code === 0 && res.data) {
      const amount = res.data.Amount || res.data.amount || res.data.balance;
      if (amount !== undefined && amount !== null) {
        const balance = parseFloat(amount);
        if (userGameInfo[userId]) userGameInfo[userId].balance = balance;
        if (!userStats[userId]) userStats[userId] = { start_balance: balance, profit: 0.0 };
        return balance;
      }
    }
    return null;
  } catch (error) { return null; }
}

async function getGameIssueRequest(session, gameType) {
  const body = { typeId: gameType === "TRX" ? 13 : 1, language: 0, random: "b05034ba4a2642009350ee863f29e2e9" };
  body.signature = generateSignature(body).toUpperCase();
  body.timestamp = Math.floor(Date.now() / 1000);
  try {
    const endpoint = gameType === "TRX" ? "GetTrxGameIssue" : "GetGameIssue";
    return (await session.post(endpoint, body)).data;
  } catch (error) { return { error: error.message }; }
}

async function placeBetRequest(session, issueNumber, selectType, unitAmount, betCount, gameType, userId) {
  const betBody = { typeId: gameType === "TRX" ? 13 : 1, issuenumber: issueNumber, language: 0, gameType: 2, amount: unitAmount, betCount: betCount, selectType: selectType, random: "9078efc98754430e92e51da59eb2563c" };
  betBody.signature = generateSignature(betBody).toUpperCase();
  betBody.timestamp = Math.floor(Date.now() / 1000);
  const endpoint = gameType === "TRX" ? "GameTrxBetting" : "GameBetting";
  for (let attempt = 0; attempt < MAX_BET_RETRIES; attempt++) {
    try { return (await session.post(endpoint, betBody)).data; }
    catch (error) { if (attempt < MAX_BET_RETRIES - 1) await new Promise(r => setTimeout(r, BET_RETRY_DELAY * 1000)); }
  }
  return { error: "Failed after retries" };
}

async function sendMessageWithRetry(ctx, text, options = null) {
  for (let attempt = 0; attempt < MAX_TELEGRAM_RETRIES; attempt++) {
    try {
      if (options) { await ctx.reply(text, options); }
      else { await ctx.reply(text); }
      return true;
    } catch (error) {
      if (error.message.includes('can\'t parse entities') && options && options.parse_mode) {
        try { delete options.parse_mode; await ctx.reply(text, options); return true; } catch (e) {}
      }
      if (attempt < MAX_TELEGRAM_RETRIES - 1) await new Promise(r => setTimeout(r, TELEGRAM_RETRY_DELAY));
    }
  }
  return false;
}

async function checkProfitAndStopLoss(userId, bot) {
  const settings = userSettings[userId] || {};
  // KENNO MAX ignores profit/stop loss
  if (settings.strategy === "KENNO_MAX") return false;
  const targetProfit = settings.target_profit;
  const stopLossLimit = settings.stop_loss;
  if (!targetProfit && !stopLossLimit) return false;
  let currentProfit, balanceText;
  if (settings.virtual_mode) {
    currentProfit = (userStats[userId].virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE;
    balanceText = `Virtual Balance: ${userStats[userId].virtual_balance.toFixed(2)} MMK\n`;
  } else {
    currentProfit = userStats[userId].profit || 0;
    const finalBalance = await getBalance(userSessions[userId], userId);
    balanceText = `Final Balance: ${finalBalance?.toFixed(2) || '0.00'} MMK\n`;
  }
  if (targetProfit && currentProfit >= targetProfit) {
    settings.running = false;
    delete userWaitingForResult[userId]; delete userShouldSkipNext[userId];
    settings.martin_index = 0; settings.dalembert_units = 1; settings.custom_index = 0;
    try { await bot.telegram.sendMessage(userId, `🎯 TARGET REACHED!\n\n✅ Profit: +${currentProfit.toFixed(2)} MMK\n\n${balanceText}`, makeMainKeyboard(true)); userStopInitiated[userId] = true; } catch(e){}
    return true;
  }
  if (stopLossLimit && currentProfit <= -stopLossLimit) {
    settings.running = false;
    delete userWaitingForResult[userId]; delete userShouldSkipNext[userId];
    settings.martin_index = 0; settings.dalembert_units = 1; settings.custom_index = 0;
    try { await bot.telegram.sendMessage(userId, `🛑 STOP LOSS TRIGGERED!\n\n❌ Loss: -${Math.abs(currentProfit).toFixed(2)} MMK\n\n${balanceText}`, makeMainKeyboard(true)); userStopInitiated[userId] = true; } catch(e){}
    return true;
  }
  return false;
}

async function winLoseChecker(bot) {
  logging.info("Win/lose checker started");
  while (true) {
    try {
      for (const [userId, session] of Object.entries(userSessions)) {
        if (!session) continue;
        const settings = userSettings[userId] || {};
        const gameType = settings.game_type || "TRX";
        let issueRes = await getGameIssueRequest(session, gameType);
        if (!issueRes || issueRes.code !== 0) continue;

        const data = gameType === "WINGO" ? (issueRes.data?.list || []) : (issueRes.data ? [issueRes.data.settled || {}] : []);

        if ((settings.strategy === "KENNO" || settings.strategy === "KENNO_V2" || settings.strategy === "KENNO_MAX") && gameType === "TRX") {
          for (const settled of data) {
            if (settled && settled.issueNumber && settled.number) {
              addKENNOResult(settled.issueNumber, settled.number);
              break;
            }
          }
        }

        if (userPendingBets[userId]) {
          for (const [period, betInfo] of Object.entries(userPendingBets[userId])) {
            const settled = data.find(item => item.issueNumber === period);
            if (settled && settled.number) {
              const [betType, amount, isVirtual, rawBetItem] = betInfo;
              const number = parseInt(settled.number || "0") % 10;
              const bigSmall = number >= 5 ? "B" : "S";
              const isWin = (betType === "B" && bigSmall === "B") || (betType === "S" && bigSmall === "S");

              if (!userAILast10Results[userId]) userAILast10Results[userId] = [];
              userAILast10Results[userId].push(bigSmall);
              if (userAILast10Results[userId].length > HISTORY_BUFFER_SIZE) userAILast10Results[userId] = userAILast10Results[userId].slice(-HISTORY_BUFFER_SIZE);

              // KENNO MAX hit/loss tracking
              if (settings.strategy === "KENNO_MAX") {
                if (isWin) {
                  if (!userKennoMaxHits[userId]) userKennoMaxHits[userId] = 0;
                  userKennoMaxHits[userId]++;
                  userKennoMaxConsecLosses[userId] = 0;
                } else {
                  if (!userKennoMaxConsecLosses[userId]) userKennoMaxConsecLosses[userId] = 0;
                  userKennoMaxConsecLosses[userId]++;
                }
              }

              const entryLayer = settings.layer_limit || 1;
              if (entryLayer > 1) {
                if (!settings.entry_layer_state) settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0 };
                if (isWin) { settings.entry_layer_state.waiting_for_loses = true; settings.entry_layer_state.consecutive_loses = 0; }
                else { settings.entry_layer_state.consecutive_loses++; }
              }

              if (settings.sl_layer && settings.sl_layer > 0) {
                if (isWin) {
                  settings.consecutive_losses = 0; userShouldSkipNext[userId] = false;
                  if (userSLSkipWaitingForWin[userId]) delete userSLSkipWaitingForWin[userId];
                  updateBettingStrategy(settings, true, amount, rawBetItem);
                } else {
                  settings.consecutive_losses = (settings.consecutive_losses || 0) + 1;
                  updateBettingStrategy(settings, false, amount, rawBetItem);
                  if (settings.consecutive_losses >= settings.sl_layer) {
                    const bs = settings.betting_strategy || "Martingale";
                    if (bs === "Martingale" || bs === "Anti-Martingale") settings.original_martin_index = settings.martin_index || 0;
                    else if (bs === "D'Alembert") settings.original_dalembert_units = settings.dalembert_units || 1;
                    else if (bs === "Custom") settings.original_custom_index = settings.custom_index || 0;
                    settings.skip_betting = true; userShouldSkipNext[userId] = true; userSLSkipWaitingForWin[userId] = true;
                  }
                }
              } else { updateBettingStrategy(settings, isWin, amount, rawBetItem); }

              if (isVirtual) {
                if (!userStats[userId].virtual_balance) userStats[userId].virtual_balance = VIRTUAL_BALANCE;
                if (isWin) userStats[userId].virtual_balance += amount * 0.96;
                else userStats[userId].virtual_balance -= amount;
              } else {
                if (userStats[userId] && amount > 0) {
                  if (isWin) userStats[userId].profit += amount * 0.96;
                  else userStats[userId].profit -= amount;
                }
              }

              const currentBalance = isVirtual ? userStats[userId].virtual_balance : await getBalance(session, parseInt(userId));
              if (await checkProfitAndStopLoss(userId, bot)) {
                delete userPendingBets[userId][period];
                if (Object.keys(userPendingBets[userId]).length === 0) delete userPendingBets[userId];
                userWaitingForResult[userId] = false;
                continue;
              }

              const totalProfit = isVirtual ? (userStats[userId].virtual_balance - VIRTUAL_BALANCE) : (userStats[userId]?.profit || 0);
              const currentHits = userKennoMaxHits[userId] || 0;
              const consecLosses = userKennoMaxConsecLosses[userId] || 0;
              let message;
              if (isWin) {
                message = `🟢 VICTORY\n\n💰 Profit: +${(amount * 0.96).toFixed(2)} MMK\n🎟️ Period: ${period}\n🎲 Result: ${number} (${bigSmall === 'B' ? 'BIG' : 'SMALL'})`;
                if (settings.strategy === "KENNO_MAX") {
                  const maxHits = settings.kenno_max_hits || 0;
                  message += `\n🎯 Sniper Hits: ${currentHits}/${maxHits === 0 ? '∞' : maxHits}`;
                }
                message += `\n\n💳 Balance: ${currentBalance?.toFixed(2) || '0.00'} MMK\n📊 Net Profit: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} MMK`;
              } else {
                message = `🔴 DEFEAT\n\n💸 Loss: -${amount} MMK\n🎟️ Period: ${period}\n🎲 Result: ${number} (${bigSmall === 'B' ? 'BIG' : 'SMALL'})`;
                if (settings.strategy === "KENNO_MAX") {
                  message += `\n⚠️ Consecutive Losses: ${consecLosses}/4`;
                }
                message += `\n\n💳 Balance: ${currentBalance?.toFixed(2) || '0.00'} MMK\n📊 Net Profit: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} MMK`;
              }
              try { await bot.telegram.sendMessage(userId, message); } catch(e){}

              delete userPendingBets[userId][period];
              if (Object.keys(userPendingBets[userId]).length === 0) delete userPendingBets[userId];
              userWaitingForResult[userId] = false;
            }
          }
        }

        if (userSkippedBets[userId]) {
          for (const [period, betInfo] of Object.entries(userSkippedBets[userId])) {
            const settled = data.find(item => item.issueNumber === period);
            if (settled && settled.number) {
              const [betType, isVirtual] = betInfo;
              const number = parseInt(settled.number || "0") % 10;
              const bigSmall = number >= 5 ? "B" : "S";
              const isWin = (betType === "B" && bigSmall === "B") || (betType === "S" && bigSmall === "S");

              if (!userAILast10Results[userId]) userAILast10Results[userId] = [];
              userAILast10Results[userId].push(bigSmall);
              if (userAILast10Results[userId].length > HISTORY_BUFFER_SIZE) userAILast10Results[userId] = userAILast10Results[userId].slice(-HISTORY_BUFFER_SIZE);

              if (userSLSkipWaitingForWin[userId] && isWin) {
                userShouldSkipNext[userId] = false; settings.skip_betting = false; settings.consecutive_losses = 0;
                delete userSLSkipWaitingForWin[userId];
                const bs = settings.betting_strategy || "Martingale";
                if (bs === "Martingale" || bs === "Anti-Martingale") settings.martin_index = settings.original_martin_index || 0;
                else if (bs === "D'Alembert") settings.dalembert_units = settings.original_dalembert_units || 1;
                else if (bs === "Custom") settings.custom_index = settings.original_custom_index || 0;
              }

              const entryLayer = settings.layer_limit || 1;
              if (entryLayer > 1) {
                if (!settings.entry_layer_state) settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0 };
                if (isWin) { settings.entry_layer_state.waiting_for_loses = true; settings.entry_layer_state.consecutive_loses = 0; }
                else { settings.entry_layer_state.consecutive_loses++; }
              }

              const resultMessage = isWin
                ? `🟢 RESULT: WIN\nPeriod: ${period}\nOutcome: ${bigSmall === 'B' ? 'BIG' : 'SMALL'} (${number})`
                : `🔴 RESULT: LOSS\nPeriod: ${period}\nOutcome: ${bigSmall === 'B' ? 'BIG' : 'SMALL'} (${number})`;
              try { await bot.telegram.sendMessage(userId, resultMessage); } catch(e){}

              delete userSkippedBets[userId][period];
              if (Object.keys(userSkippedBets[userId]).length === 0) delete userSkippedBets[userId];
              if (userSkipResultWait[userId] === period) delete userSkipResultWait[userId];
            }
          }
        }
      }
      await new Promise(r => setTimeout(r, WIN_LOSE_CHECK_INTERVAL * 1000));
    } catch (error) {
      logging.error(`Checker error: ${error.message}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

async function bettingWorker(userId, ctx, bot) {
  const settings = userSettings[userId] || {};
  let session = userSessions[userId];
  if (!settings || !session) { await sendMessageWithRetry(ctx, "⚠️ Please login first to access the bot."); settings.running = false; return; }

  if (!userStats[userId]) {
    if (settings.virtual_mode) userStats[userId] = { virtual_balance: VIRTUAL_BALANCE };
    else userStats[userId] = { start_balance: 0.0, profit: 0.0 };
  }

  settings.running = true;
  settings.last_issue = null;
  settings.consecutive_errors = 0;
  settings.consecutive_losses = 0;
  settings.current_layer = 0;
  settings.skip_betting = false;
  if (settings.original_martin_index === undefined) settings.original_martin_index = 0;
  if (settings.original_dalembert_units === undefined) settings.original_dalembert_units = 1;
  if (settings.original_custom_index === undefined) settings.original_custom_index = 0;
  userShouldSkipNext[userId] = false;
  delete userSLSkipWaitingForWin[userId];

  // Reset KENNO MAX counters on start
  if (settings.strategy === "KENNO_MAX") {
    userKennoMaxHits[userId] = 0;
    userKennoMaxConsecLosses[userId] = 0;
  }

  const entryLayer = settings.layer_limit || 1;
  if (entryLayer > 1) settings.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0 };
  if (settings.strategy === "AI_PREDICTION") { userAILast10Results[userId] = []; userAIRoundCount[userId] = 0; }

  let currentBalance = null;
  if (settings.virtual_mode) currentBalance = userStats[userId].virtual_balance || VIRTUAL_BALANCE;
  else {
    let balanceRetrieved = false;
    for (let attempt = 0; attempt < MAX_BALANCE_RETRIES; attempt++) {
      try {
        const balanceResult = await getBalance(session, parseInt(userId));
        if (balanceResult !== null) { currentBalance = balanceResult; userStats[userId].start_balance = currentBalance; balanceRetrieved = true; break; }
      } catch (error) { logging.error(`Balance attempt ${attempt + 1} failed`); }
      if (attempt < MAX_BALANCE_RETRIES - 1) await new Promise(r => setTimeout(r, BALANCE_RETRY_DELAY * 1000));
    }
    if (!balanceRetrieved) { await sendMessageWithRetry(ctx, "❌ Failed to verify balance. Please try again.", makeMainKeyboard(true)); settings.running = false; return; }
  }

  const maxHitsDisplay = settings.strategy === "KENNO_MAX"
    ? `\n🎯 Target Hits: ${(settings.kenno_max_hits || 0) === 0 ? '∞ Unlimited' : settings.kenno_max_hits}`
    : '';
  await sendMessageWithRetry(ctx, `🚀 BOT ACTIVATED\n\n💰 Starting Balance: ${currentBalance} MMK\n🤖 Strategy: ${settings.strategy}${maxHitsDisplay}\n\nWaiting for next round...`);

  try {
    while (settings.running) {
      if (userWaitingForResult[userId]) { await new Promise(r => setTimeout(r, 1000)); continue; }
      if (userSkipResultWait[userId]) { await new Promise(r => setTimeout(r, 1000)); continue; }

      if (settings.virtual_mode) currentBalance = userStats[userId].virtual_balance || VIRTUAL_BALANCE;
      else {
        try { const b = await getBalance(session, parseInt(userId)); if (b !== null) currentBalance = b; }
        catch (error) { if (currentBalance === null) currentBalance = userStats[userId].start_balance || 0; }
      }

      if (currentBalance === null) {
        let recovered = false;
        for (let i = 0; i < 3; i++) {
          try { const b = await getBalance(session, parseInt(userId)); if (b !== null) { currentBalance = b; recovered = true; break; } await new Promise(r => setTimeout(r, 2000)); } catch(e) {}
        }
        if (!recovered) { await sendMessageWithRetry(ctx, "❌ Connection Unstable. Balance check failed.", makeMainKeyboard(true)); settings.running = false; break; }
      }

      const betSizes = settings.bet_sizes || [100];
      if (!betSizes.length) { await sendMessageWithRetry(ctx, "⚠️ Please set your Bet Size first.", makeMainKeyboard(true)); settings.running = false; break; }
      if (currentBalance < 100) {
        await sendMessageWithRetry(ctx, `❌ Insufficient Balance!\n\nCurrent: ${currentBalance.toFixed(2)} MMK`, makeMainKeyboard(true));
        settings.running = false; break;
      }

      const gameType = settings.game_type || "TRX";
      let issueRes;
      try {
        issueRes = await getGameIssueRequest(session, gameType);
        if (!issueRes || issueRes.code !== 0) {
          settings.consecutive_errors++;
          if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) { await sendMessageWithRetry(ctx, "❌ Too many API errors. Stopping bot.", makeMainKeyboard(true)); settings.running = false; break; }
          await new Promise(r => setTimeout(r, 2000)); continue;
        }
      } catch (error) {
        settings.consecutive_errors++;
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) { await sendMessageWithRetry(ctx, "❌ Too many API errors. Stopping bot.", makeMainKeyboard(true)); settings.running = false; break; }
        await new Promise(r => setTimeout(r, 2000)); continue;
      }
      settings.consecutive_errors = 0;

      let currentIssue = gameType === "TRX" ? issueRes.data?.predraw?.issueNumber : issueRes.data?.issueNumber;
      if (!currentIssue || currentIssue === settings.last_issue) { await new Promise(r => setTimeout(r, 1000)); continue; }

      let ch;
      let kennoInfo = null;

      if (settings.strategy === "KENNO") {
        const prediction = getKENNOPrediction();
        if (!prediction) {
          const currentKENNO = loadKENNOResults();
          const need = KENNO_REQUIRED - currentKENNO.length;
          const waitMsg = `⏳ WAITING FOR DATA\n\nPeriod: ${currentIssue}\nStrategy: KENNO\nStatus: Collecting results (${currentKENNO.length}/${KENNO_REQUIRED})\nNeed ${need} more results...`;
          await sendMessageWithRetry(ctx, waitMsg);
          settings.last_issue = currentIssue;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        ch = prediction.result;
        kennoInfo = prediction;
      } else if (settings.strategy === "KENNO_V2") {
        const prediction = getKENNOV2Prediction();
        if (!prediction) {
          const currentKENNO = loadKENNOResults();
          const waitMsg = `⏳ WAITING FOR DATA\n\nPeriod: ${currentIssue}\nStrategy: KENNO V2\nStatus: Collecting results (${currentKENNO.length}/3)`;
          await sendMessageWithRetry(ctx, waitMsg);
          settings.last_issue = currentIssue;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        ch = prediction.result;
        kennoInfo = prediction;
      } else if (settings.strategy === "KENNO_MAX") {
        if (!userKennoMaxConsecLosses[userId]) userKennoMaxConsecLosses[userId] = 0;
        if (userKennoMaxConsecLosses[userId] >= 4) {
          await sendMessageWithRetry(ctx, `🛑 KENNO MAX STOPPED\n\n⚠️ 4 Consecutive losses reached!\n\n💳 Balance: ${currentBalance.toFixed(2)} MMK`, makeMainKeyboard(true));
          settings.running = false;
          userStopInitiated[userId] = true;
          break;
        }

        if (!userKennoMaxHits[userId]) userKennoMaxHits[userId] = 0;
        const maxHits = settings.kenno_max_hits || 0;
        if (maxHits > 0 && userKennoMaxHits[userId] >= maxHits) {
          await sendMessageWithRetry(ctx, `🎯 KENNO MAX COMPLETE!\n\n✅ Reached ${maxHits} hit(s)!\n\n💳 Balance: ${currentBalance.toFixed(2)} MMK`, makeMainKeyboard(true));
          settings.running = false;
          userStopInitiated[userId] = true;
          break;
        }

        const prediction = getKENNOMaxPrediction();
        if (!prediction) {
          const currentKENNO = loadKENNOResults();
          const waitMsg = `⏳ WAITING FOR DATA\n\nPeriod: ${currentIssue}\nStrategy: KENNO MAX\nStatus: Collecting (${currentKENNO.length}/${KENNO_MAX_REQUIRED})`;
          await sendMessageWithRetry(ctx, waitMsg);
          settings.last_issue = currentIssue;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        if (prediction.skip) {
          settings.last_issue = currentIssue;
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        ch = prediction.result;
        kennoInfo = prediction;
      } else if (settings.strategy === "AI_PREDICTION") {
        const prediction = await getAIPrediction(userId);
        ch = prediction ? prediction.result : (Math.random() < 0.5 ? 'B' : 'S');
      } else if (settings.strategy === "TREND_FOLLOW") {
        ch = (userAILast10Results[userId] && userAILast10Results[userId].length > 0) ? userAILast10Results[userId][userAILast10Results[userId].length - 1] : (Math.random() < 0.5 ? 'B' : 'S');
      } else if (settings.strategy === "ALTERNATE") {
        if (userAILast10Results[userId] && userAILast10Results[userId].length > 0) { const last = userAILast10Results[userId][userAILast10Results[userId].length - 1]; ch = last === 'B' ? 'S' : 'B'; }
        else ch = Math.random() < 0.5 ? 'B' : 'S';
      } else if (settings.strategy === "BS_ORDER") {
        if (!settings.pattern) { settings.pattern = DEFAULT_BS_ORDER; settings.pattern_index = 0; }
        ch = settings.pattern[settings.pattern_index % settings.pattern.length];
      } else {
        const prediction = await getAIPrediction(userId);
        ch = prediction ? prediction.result : (Math.random() < 0.5 ? 'B' : 'S');
      }

      const selectType = getSelectMap()[ch];
      if (selectType === undefined) { await new Promise(r => setTimeout(r, 2000)); continue; }

      let shouldSkip = false, skipReason = "";
      const requiredLosses = (entryLayer > 1) ? entryLayer : 0;
      if (entryLayer > 1 && settings.entry_layer_state?.waiting_for_loses && settings.entry_layer_state.consecutive_loses < requiredLosses) {
        shouldSkip = true;
        skipReason = `Entry Layer (${requiredLosses})\nWaiting for ${requiredLosses - settings.entry_layer_state.consecutive_loses} more loss(es)`;
      }
      if (!shouldSkip && userShouldSkipNext[userId]) { shouldSkip = true; skipReason = "Skip Loss Active"; }

      if (shouldSkip) {
        let betMsg = `⏭️ SKIPPING BET\n\nPeriod: ${currentIssue}\nPrediction: ${ch === 'B' ? 'BIG' : 'SMALL'}\nReason: ${skipReason}`;
        if (!userSkippedBets[userId]) userSkippedBets[userId] = {};
        userSkippedBets[userId][currentIssue] = [ch, settings.virtual_mode];
        userSkipResultWait[userId] = currentIssue;
        await sendMessageWithRetry(ctx, betMsg);
        let resultAvailable = false, waitAttempts = 0;
        while (!resultAvailable && waitAttempts < 60 && settings.running) {
          await new Promise(r => setTimeout(r, 1000));
          if (!userSkippedBets[userId] || !userSkippedBets[userId][currentIssue]) resultAvailable = true;
          waitAttempts++;
        }
      } else {
        let desiredAmount = 0;
        let rawBetItem = null;
        if (settings.betting_strategy === "D'Alembert") {
          rawBetItem = betSizes[0];
          desiredAmount = calculateBetAmount(settings, currentBalance);
        } else if (settings.betting_strategy === "Martingale" || settings.betting_strategy === "Anti-Martingale") {
          const idx = Math.min(settings.martin_index || 0, betSizes.length - 1);
          rawBetItem = betSizes[idx];
        } else {
          const idx = Math.min(settings.custom_index || 0, betSizes.length - 1);
          rawBetItem = betSizes[idx];
        }
        if (rawBetItem === "ALL_IN") {
          desiredAmount = Math.floor(currentBalance / 100) * 100;
          if (desiredAmount < 100) {
            await sendMessageWithRetry(ctx, "❌ Insufficient Balance for ALL IN.", makeMainKeyboard(true));
            settings.running = false; break;
          }
        } else if (typeof rawBetItem === 'number') {
          if (settings.betting_strategy === "Martingale" || settings.betting_strategy === "Anti-Martingale" || settings.betting_strategy === "Custom") {
            desiredAmount = rawBetItem;
          } else {
            desiredAmount = calculateBetAmount(settings, currentBalance);
          }
        } else {
          desiredAmount = calculateBetAmount(settings, currentBalance);
        }

        const { unitAmount, betCount, actualAmount } = computeBetDetails(desiredAmount);
        if (actualAmount === 0 || currentBalance < actualAmount) {
          await sendMessageWithRetry(ctx, `❌ Insufficient balance for this bet level.`, makeMainKeyboard(true));
          settings.running = false; break;
        }

        let betMsg = `🎲 BET PLACED\n\nPeriod: ${currentIssue}\nSelection: ${ch === 'B' ? 'BIG' : 'SMALL'}\nAmount: ${actualAmount} MMK`;
        if (settings.strategy === "KENNO_MAX" && kennoInfo) {
          const maxHits = settings.kenno_max_hits || 0;
          betMsg += `\n\n🎯 Sniper Info:\nBet => ${ch === 'B' ? 'BIG' : 'SMALL'}\nHits: ${userKennoMaxHits[userId] || 0}/${maxHits === 0 ? '∞' : maxHits}\nConsec Losses: ${userKennoMaxConsecLosses[userId] || 0}/4`;
        }
        await sendMessageWithRetry(ctx, betMsg);

        if (settings.virtual_mode) {
          if (!userPendingBets[userId]) userPendingBets[userId] = {};
          userPendingBets[userId][currentIssue] = [ch, actualAmount, true, rawBetItem];
          userWaitingForResult[userId] = true;
        } else {
          const betResp = await placeBetRequest(session, currentIssue, selectType, unitAmount, betCount, gameType, parseInt(userId));
          if (betResp.error || betResp.code !== 0) { await sendMessageWithRetry(ctx, `⚠️ Bet Error: ${betResp.msg || betResp.error}. Retrying...`); await new Promise(r => setTimeout(r, 5000)); continue; }
          if (!userPendingBets[userId]) userPendingBets[userId] = {};
          userPendingBets[userId][currentIssue] = [ch, actualAmount, false, rawBetItem];
          userWaitingForResult[userId] = true;
        }
      }

      settings.last_issue = currentIssue;
      if (settings.pattern || settings.strategy === "BS_ORDER") settings.pattern_index = (settings.pattern_index + 1) % (settings.pattern ? settings.pattern.length : 10);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (error) {
    logging.error(`Worker error: ${error.message}`);
    await sendMessageWithRetry(ctx, `⚠️ Critical Error: ${error.message}`);
    settings.running = false;
  } finally {
    settings.running = false;
    delete userWaitingForResult[userId]; delete userShouldSkipNext[userId]; delete userBalanceWarnings[userId];
    delete userSkipResultWait[userId]; delete userSLSkipWaitingForWin[userId];
    if (settings.strategy === "AI_PREDICTION") { delete userAILast10Results[userId]; delete userAIRoundCount[userId]; }
    if (settings.strategy === "KENNO_MAX") { delete userKennoMaxHits[userId]; delete userKennoMaxConsecLosses[userId]; }

    let totalProfit = 0, balanceText = "";
    if (settings.virtual_mode) {
      totalProfit = (userStats[userId]?.virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE;
      balanceText = `Virtual: ${(userStats[userId]?.virtual_balance || VIRTUAL_BALANCE).toFixed(2)} MMK\n`;
    } else {
      totalProfit = userStats[userId]?.profit || 0;
      try { const fb = await getBalance(session, userId); balanceText = `Balance: ${fb?.toFixed(2) || '0.00'} MMK\n`; } catch(e) { balanceText = "Balance: Unknown\n"; }
    }
    let pi = totalProfit > 0 ? "+" : (totalProfit < 0 ? "-" : "");
    delete userStats[userId]; settings.martin_index = 0; settings.dalembert_units = 1; settings.custom_index = 0;
    if (!userStopInitiated[userId]) { await sendMessageWithRetry(ctx, `🛑 BOT STOPPED\n\n${balanceText}📊 Total Profit: ${pi}${totalProfit.toFixed(2)} MMK`, makeMainKeyboard(true)); }
    delete userStopInitiated[userId];
  }
}

function makeMainKeyboard(loggedIn = false) {
  if (!loggedIn) return Markup.keyboard([["🔑 Login Account"]]).resize().oneTime(false);
  return Markup.keyboard([
    ["▶️ Start Bot", "⏹️ Stop Bot"],
    ["🎯 Pick Strategy", "💰 Bet Size"],
    ["📈 Profit Target", "📉 Stop Loss"],
    ["🤖 Plan Mode", "💎 Mode (V/R)"],
    ["🔄 Entry Layer", "💥 Skip Loss"],
    ["📊 My Stats", "🔑 Re-Login"]
  ]).resize().oneTime(false);
}

function makeStrategyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📜 BS Order", "strategy:BS_ORDER"), Markup.button.callback("🤖 AI Prediction", "strategy:AI_PREDICTION")],
    [Markup.button.callback("📈 Trend Follow", "strategy:TREND_FOLLOW"), Markup.button.callback("🔄 Alternate", "strategy:ALTERNATE")],
    [Markup.button.callback("🎲 KENNO", "strategy:KENNO"), Markup.button.callback("🎯 KENNO V2", "strategy:KENNO_V2")],
    [Markup.button.callback("🎯 KENNO MAX (Sniper)", "strategy:KENNO_MAX")]
  ]);
}

function makeBettingStrategyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Anti-Martingale", "betting_strategy:Anti-Martingale")],
    [Markup.button.callback("Martingale", "betting_strategy:Martingale")],
    [Markup.button.callback("D'Alembert", "betting_strategy:D'Alembert")]
  ]);
}

function makeEntryLayerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1 Layer", "entry_layer:1")],
    [Markup.button.callback("2 Layers", "entry_layer:2")],
    [Markup.button.callback("3 Layers", "entry_layer:3")],
    [Markup.button.callback("4 Layers", "entry_layer:4")],
    [Markup.button.callback("5 Layers", "entry_layer:5")],
    [Markup.button.callback("6 Layers", "entry_layer:6")],
    [Markup.button.callback("7 Layers", "entry_layer:7")],
    [Markup.button.callback("8 Layers", "entry_layer:8")],
    [Markup.button.callback("9 Layers", "entry_layer:9")]
  ]);
}

function makeSLLayerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Disabled", "sl_layer:0")],
    [Markup.button.callback("1 Loss", "sl_layer:1"), Markup.button.callback("2 Losses", "sl_layer:2"), Markup.button.callback("3 Losses", "sl_layer:3")],
    [Markup.button.callback("4 Losses", "sl_layer:4"), Markup.button.callback("5 Losses", "sl_layer:5"), Markup.button.callback("6 Losses", "sl_layer:6")],
    [Markup.button.callback("7 Losses", "sl_layer:7"), Markup.button.callback("8 Losses", "sl_layer:8"), Markup.button.callback("9 Losses", "sl_layer:9")]
  ]);
}

function makeKennoMaxHitsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1 Hit", "kenno_max_hits:1"), Markup.button.callback("2 Hits", "kenno_max_hits:2"), Markup.button.callback("3 Hits", "kenno_max_hits:3")],
    [Markup.button.callback("4 Hits", "kenno_max_hits:4"), Markup.button.callback("5 Hits", "kenno_max_hits:5"), Markup.button.callback("10 Hits", "kenno_max_hits:10")],
    [Markup.button.callback("20 Hits", "kenno_max_hits:20"), Markup.button.callback("50 Hits", "kenno_max_hits:50"), Markup.button.callback("♾️ Unlimited", "kenno_max_hits:0")]
  ]);
}

function makeModeSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧪 Demo Mode", "mode:virtual")],
    [Markup.button.callback("💸 Real Money", "mode:real")]
  ]);
}

function makeBetSizeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("100", "bet_size:100"), Markup.button.callback("200", "bet_size:200")],
    [Markup.button.callback("300", "bet_size:300"), Markup.button.callback("500", "bet_size:500")],
    [Markup.button.callback("3000", "bet_size:3000"), Markup.button.callback("💎 ALL IN", "bet_size:ALL_IN")],
    [Markup.button.callback("✏️ Custom Input", "bet_size:CUSTOM")]
  ]);
}

async function checkUserAuthorized(ctx) {
  if (!userSessions[ctx.from.id]) { await sendMessageWithRetry(ctx, "⚠️ Access Denied. Please login first.", makeMainKeyboard(false)); return false; }
  if (!userSettings[ctx.from.id]) {
    userSettings[ctx.from.id] = {
      strategy: "KENNO_V2", betting_strategy: "Martingale", game_type: "TRX", martin_index: 0,
      dalembert_units: 1, pattern_index: 0, running: false, consecutive_losses: 0, current_layer: 0,
      skip_betting: false, sl_layer: null, original_martin_index: 0, original_dalembert_units: 1,
      original_custom_index: 0, custom_index: 0, layer_limit: 1, virtual_mode: false,
      bet_sizes: [1000, 3000, 7000, 16000, 36000, 76000, 160000, 360000]
    };
  }
  return true;
}

async function cmdStartHandler(ctx) {
  if (!userSettings[ctx.from.id]) {
    userSettings[ctx.from.id] = {
      strategy: "KENNO_V2", betting_strategy: "Martingale", game_type: "TRX", martin_index: 0,
      dalembert_units: 1, pattern_index: 0, running: false, consecutive_losses: 0, current_layer: 0,
      skip_betting: false, sl_layer: null, original_martin_index: 0, original_dalembert_units: 1,
      original_custom_index: 0, custom_index: 0, layer_limit: 1, virtual_mode: false,
      bet_sizes: [1000, 3000, 7000, 16000, 36000, 76000, 160000, 360000]
    };
  }
  await sendMessageWithRetry(ctx, "👋 Welcome to CK Auto-Bot\n\nPlease login to continue.");
  await sendMessageWithRetry(ctx, "Press the button below 👇", makeMainKeyboard(!!userSessions[ctx.from.id]));
}

async function cmdAllowHandler(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length || !args[0].match(/^\d+$/)) { await sendMessageWithRetry(ctx, "Usage: /allow {id}"); return; }
  const id = parseInt(args[0]);
  if (allowedcklotteryIds.has(id)) { await sendMessageWithRetry(ctx, `User ${id} already added`); }
  else { allowedcklotteryIds.add(id); saveAllowedUsers(); await sendMessageWithRetry(ctx, `User ${id} added`); }
}

async function cmdRemoveHandler(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length || !args[0].match(/^\d+$/)) { await sendMessageWithRetry(ctx, "Usage: /remove {id}"); return; }
  const id = parseInt(args[0]);
  if (!allowedcklotteryIds.has(id)) { await sendMessageWithRetry(ctx, `User ${id} not found`); }
  else { allowedcklotteryIds.delete(id); saveAllowedUsers(); await sendMessageWithRetry(ctx, `User ${id} removed`); }
}

async function cmdShowHandler(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  const ids = Array.from(allowedcklotteryIds);
  if (!ids.length) { await sendMessageWithRetry(ctx, "No users"); return; }
  let msg = "👥 Authorized Users\n\n"; ids.forEach((id, i) => { msg += `${i + 1}. ${id}\n`; });
  msg += `\nTotal: ${ids.length}`; await sendMessageWithRetry(ctx, msg);
}

async function callbackQueryHandler(ctx) {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if (!await checkUserAuthorized(ctx)) return;

  if (data.startsWith("strategy:")) {
    const strategy = data.split(":")[1];
    userSettings[userId].strategy = strategy;
    if (strategy === "BS_ORDER") {
      userState[userId] = { state: "INPUT_BS_PATTERN" };
      await sendMessageWithRetry(ctx, "📝 Please enter your BS pattern (e.g. BSBSSBBS):");
    } else if (strategy === "KENNO") {
      await sendMessageWithRetry(ctx, `✅ Strategy set to KENNO`);
    } else if (strategy === "KENNO_V2") {
      const kr = loadKENNOResults();
      if (kr && kr.length >= 3) {
        const num1 = parseInt(kr[0].number) % 10;
        const num2 = parseInt(kr[1].number) % 10;
        const num3 = parseInt(kr[2].number) % 10;
        const weightedSum = (num1 * 0.5) + (num2 * 0.3) + (num3 * 0.2);
        betOrder = `KENNO V2: ${weightedSum.toFixed(2)} => ${weightedSum >= 5 ? 'BIG' : 'SMALL'}`;
      } else {
        betOrder = `KENNO V2: Collecting (${loadKENNOResults().length}/3)...`;
      }
    } else if (strategy === "KENNO_MAX") {
      userSettings[userId].kenno_max_hits = 0;
      userKennoMaxHits[userId] = 0;
      userKennoMaxConsecLosses[userId] = 0;
      await sendMessageWithRetry(ctx, `🎯 KENNO MAX (Sniper) Selected!\n\n📐 Formula: Last 2 results added\n0-4 = Small (bet BIG)\n5-9 = Big (bet SMALL)\n\n⚠️ Auto-stops after 4 consecutive losses\n\nHow many times should the Sniper hit?`, makeKennoMaxHitsKeyboard());
    } else {
      await sendMessageWithRetry(ctx, `✅ Strategy: ${strategy}`);
    }
    await ctx.deleteMessage();
  } else if (data.startsWith("kenno_max_hits:")) {
    const hits = parseInt(data.split(":")[1]);
    userSettings[userId].kenno_max_hits = hits;
    userKennoMaxHits[userId] = 0;
    userKennoMaxConsecLosses[userId] = 0;
    const hitsText = hits === 0 ? "♾️ Unlimited" : `${hits} hit(s)`;
    await sendMessageWithRetry(ctx, `✅ KENNO MAX (Sniper) Ready!\n\n🎯 Target Hits: ${hitsText}\n⚠️ Stops after 4 consecutive losses\n\nPress ▶️ Start Bot when ready!`, makeMainKeyboard(true));
    try { await ctx.deleteMessage(); } catch(e){}
  } else if (data.startsWith("betting_strategy:")) {
    const s = data.split(":")[1];
    userSettings[userId].betting_strategy = s;
    userSettings[userId].martin_index = 0; userSettings[userId].dalembert_units = 1;
    userSettings[userId].consecutive_losses = 0; userSettings[userId].skip_betting = false; userSettings[userId].custom_index = 0;
    await sendMessageWithRetry(ctx, `✅ Plan Mode: ${s}`); await ctx.deleteMessage();
  } else if (data.startsWith("entry_layer:")) {
    const v = parseInt(data.split(":")[1]);
    userSettings[userId].layer_limit = v;
    if (v > 1) userSettings[userId].entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0 };
    await sendMessageWithRetry(ctx, `✅ Entry Layer set to: ${v}`, makeMainKeyboard(true)); await ctx.deleteMessage();
  } else if (data.startsWith("sl_layer:")) {
    const v = parseInt(data.split(":")[1]);
    userSettings[userId].sl_layer = v > 0 ? v : null;
    userSettings[userId].consecutive_losses = 0; userSettings[userId].skip_betting = false;
    userSettings[userId].original_martin_index = 0; userSettings[userId].original_dalembert_units = 1; userSettings[userId].original_custom_index = 0;
    await sendMessageWithRetry(ctx, `✅ Skip Loss: ${v > 0 ? v + ' Losses' : 'Disabled'}`, makeMainKeyboard(true)); await ctx.deleteMessage();
  } else if (data.startsWith("mode:")) {
    const mode = data.split(":")[1];
    const s = userSettings[userId];
    if (mode === "virtual") { s.virtual_mode = true; if (!userStats[userId]) userStats[userId] = {}; if (userStats[userId].virtual_balance === undefined) userStats[userId].virtual_balance = VIRTUAL_BALANCE; await sendMessageWithRetry(ctx, `🧪 Demo Mode Activated\nBalance: ${VIRTUAL_BALANCE} MMK`); }
    else { s.virtual_mode = false; await sendMessageWithRetry(ctx, "💸 Real Money Mode Activated"); }
    await ctx.deleteMessage();
  } else if (data.startsWith("bet_size:")) {
    const val = data.split(":")[1];
    const s = userSettings[userId];

    if (val === "CUSTOM") {
      userState[userId] = { state: "INPUT_BET_SIZES" };
      await sendMessageWithRetry(ctx, "💰 Set Bet Sizes\n\nEnter amounts like this.\n\n100\n500\nALL IN\n\nYou can use numbers and 'ALL IN':");
      try { await ctx.deleteMessage(); } catch(e){}
      return;
    }

    if (val === "ALL_IN") {
      let currentBalance = 0;
      if (s.virtual_mode) {
        currentBalance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE;
      } else {
        const b = await getBalance(userSessions[userId], userId);
        currentBalance = b || 0;
      }
      const allInAmount = Math.floor(currentBalance / 100) * 100;
      if (allInAmount < 100) {
        await sendMessageWithRetry(ctx, "❌ Insufficient Balance for All In (Min 100 MMK).");
      } else {
        s.bet_sizes = [allInAmount];
        s.martin_index = 0; s.dalembert_units = 1; s.custom_index = 0;
        const remainder = (currentBalance - allInAmount).toFixed(2);
        await sendMessageWithRetry(ctx, `💎 ALL IN SET!\n\nBet Amount: ${allInAmount} MMK\nRemaining Balance: ${remainder} MMK`, makeMainKeyboard(true));
      }
    } else {
      const amount = parseInt(val);
      if (!isNaN(amount)) {
        s.bet_sizes = [amount];
        s.martin_index = 0; s.dalembert_units = 1; s.custom_index = 0;
        await sendMessageWithRetry(ctx, `✅ Bet Size set to: ${amount} MMK`, makeMainKeyboard(true));
      }
    }
    try { await ctx.deleteMessage(); } catch(e){}
  }
}

async function textMessageHandler(ctx) {
  const userId = ctx.from.id;
  const rawText = ctx.message.text;
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  if (rawText.includes("🔑 Login Account") || rawText.includes("🔑 Re-Login")) {
    await sendMessageWithRetry(ctx, "🔐 Account Login\n\nPlease enter your login info:\n\nLine 1: Login\nLine 2: Phone Number\nLine 3: Password");
    return;
  }
  if (rawText.includes("My Stats")) {
    try {
      if (!userSessions[userId]) { await sendMessageWithRetry(ctx, "⚠️ Please login first.", makeMainKeyboard(false)); return; }
      await showUserStats(ctx, userId);
    } catch (error) { await sendMessageWithRetry(ctx, `❌ Error loading stats: ${error.message}`); }
    return;
  }

  if (rawText.includes("▶️ Start Bot")) {
    const s = userSettings[userId] || {};
    if (!s.bet_sizes) { await sendMessageWithRetry(ctx, "⚠️ Please set your Bet Size first!", makeMainKeyboard(true)); return; }
    if (s.strategy === "BS_ORDER" && !s.pattern) { s.pattern = DEFAULT_BS_ORDER; s.pattern_index = 0; }
    if (s.betting_strategy === "D'Alembert" && s.bet_sizes.length > 1) { await sendMessageWithRetry(ctx, "❌ D'Alembert strategy requires only ONE bet size.", makeMainKeyboard(true)); return; }
    if (s.strategy === "KENNO_MAX" && s.kenno_max_hits === undefined) { await sendMessageWithRetry(ctx, "⚠️ Please select KENNO MAX from strategy menu first to set hit count!", makeMainKeyboard(true)); return; }
    if (s.running) { await sendMessageWithRetry(ctx, "⚠️ The bot is already running!", makeMainKeyboard(true)); return; }
    s.running = true; s.consecutive_errors = 0;
    const el = s.layer_limit || 1;
    if (el > 1) s.entry_layer_state = { waiting_for_loses: true, consecutive_loses: 0 };
    if (s.strategy === "AI_PREDICTION") { userAILast10Results[userId] = []; userAIRoundCount[userId] = 0; }
    delete userSkippedBets[userId]; userShouldSkipNext[userId] = false; delete userSLSkipWaitingForWin[userId]; userWaitingForResult[userId] = false;
    bettingWorker(userId, ctx, ctx.telegram);
    return;
  }
  if (rawText.includes("⏹️ Stop Bot")) {
    const s = userSettings[userId] || {};
    if (!s.running) { await sendMessageWithRetry(ctx, "⚠️ The bot is not currently running.", makeMainKeyboard(true)); return; }
    userStopInitiated[userId] = true; s.running = false; delete userWaitingForResult[userId]; delete userShouldSkipNext[userId]; delete userSLSkipWaitingForWin[userId];
    if (s.strategy === "AI_PREDICTION") { delete userAILast10Results[userId]; delete userAIRoundCount[userId]; }
    if (s.strategy === "KENNO_MAX") { delete userKennoMaxHits[userId]; delete userKennoMaxConsecLosses[userId]; }
    let tp = 0, bt = "";
    if (s.virtual_mode) { tp = (userStats[userId]?.virtual_balance || VIRTUAL_BALANCE) - VIRTUAL_BALANCE; bt = `Virtual Balance: ${(userStats[userId]?.virtual_balance || VIRTUAL_BALANCE).toFixed(2)} MMK\n`; }
    else { tp = userStats[userId]?.profit || 0; try { const fb = await getBalance(userSessions[userId], userId); bt = `Real Balance: ${fb?.toFixed(2) || '0.00'} MMK\n`; } catch(e) {} }
    let pi = tp > 0 ? "+" : (tp < 0 ? "-" : "");
    delete userStats[userId]; s.martin_index = 0; s.dalembert_units = 1; s.custom_index = 0;
    await sendMessageWithRetry(ctx, `🛑 BOT STOPPED MANUALLY\n\n${bt}💰 Session Profit: ${pi}${tp.toFixed(2)} MMK`, makeMainKeyboard(true));
    return;
  }
  if (rawText.includes("💰 Bet Size")) { await sendMessageWithRetry(ctx, "💰 Select Bet Size:", makeBetSizeKeyboard()); return; }
  if (rawText.includes("💎 Mode (V/R)")) { await sendMessageWithRetry(ctx, "🎛️ Select Mode", makeModeSelectionKeyboard()); return; }
  if (rawText.includes("📈 Profit Target")) { userState[userId] = { state: "INPUT_PROFIT_TARGET" }; await sendMessageWithRetry(ctx, "📈 Set Profit Target\n\nEnter amount (e.g. 100000):"); return; }
  if (rawText.includes("📉 Stop Loss")) { userState[userId] = { state: "INPUT_STOP_LIMIT" }; await sendMessageWithRetry(ctx, "📉 Set Stop Loss Limit\n\nEnter amount (e.g. 50000):"); return; }
  if (rawText.includes("🎯 Pick Strategy")) { await sendMessageWithRetry(ctx, "🧠 Choose Prediction Strategy", makeStrategyKeyboard()); return; }
  if (rawText.includes("🔄 Entry Layer")) { await sendMessageWithRetry(ctx, "🔄 Set Entry Layer\nWait for X consecutive losses before starting.", makeEntryLayerKeyboard()); return; }
  if (rawText.includes("💥 Skip Loss")) { await sendMessageWithRetry(ctx, "💥 Set Skip Loss\nSkip betting after X consecutive losses until a win.", makeSLLayerKeyboard()); return; }
  if (rawText.includes("🤖 Plan Mode")) { await sendMessageWithRetry(ctx, "🤖 Choose Betting Plan", makeBettingStrategyKeyboard()); return; }

  const command = text.toUpperCase().replace(/[_ /\(\)▶️⏹️💰💎📈📉🎯🤖🔄💥📊🔑]/g, '');
  if (command === "LOGIN" || (lines.length > 0 && lines[0].toLowerCase() === "login")) {
    if (lines.length >= 3 && lines[0].toLowerCase() === "login") {
      await sendMessageWithRetry(ctx, "🔄 Verify! Please Wait...");
      const { response: res, session } = await loginRequest(lines[1], lines[2]);
      if (session) {
        const userInfo = await getUserInfo(session, userId);
        if (userInfo && userInfo.user_id) {
          if (!allowedcklotteryIds.has(userInfo.user_id)) {
            await sendMessageWithRetry(ctx, `⛔ Access Denied\n\nYour Game ID (${userInfo.user_id}) is not authorized.\n\nPlease contact @KenoDoingSmth for access.`);
            return;
          }
          userSessions[userId] = session; userGameInfo[userId] = userInfo;
          const balance = await getBalance(session, userId);
          if (!userSettings[userId]) userSettings[userId] = {
            strategy: "KENNO_V2", betting_strategy: "Martingale", game_type: "TRX", martin_index: 0,
            dalembert_units: 1, pattern_index: 0, running: false, consecutive_losses: 0, current_layer: 0,
            skip_betting: false, sl_layer: null, original_martin_index: 0, original_dalembert_units: 1,
            original_custom_index: 0, custom_index: 0, layer_limit: 1, virtual_mode: false,
            bet_sizes: [1000, 3000, 7000, 16000, 36000, 76000, 160000, 360000]
          };
          if (!userStats[userId]) userStats[userId] = { start_balance: parseFloat(balance || 0), profit: 0.0 };
          await sendMessageWithRetry(ctx, `✅ Login Successful\n\n👤 ID: ${userInfo.user_id}\n💰 Balance: ${balance || 0} MMK`, makeMainKeyboard(true));
        } else { await sendMessageWithRetry(ctx, "❌ Login failed. Invalid credentials.", makeMainKeyboard(false)); }
      } else { await sendMessageWithRetry(ctx, `❌ Login Error: ${res.msg || 'Unknown'}`, makeMainKeyboard(false)); }
      delete userState[userId];
      return;
    }
    await sendMessageWithRetry(ctx, "🔐 Account Login\n\nPlease enter your login info:\n\nLine 1: Login\nLine 2: Phone Number\nLine 3: Password");
    return;
  }

  if (!await checkUserAuthorized(ctx)) return;
  try {
    const cs = userState[userId]?.state;
    if (cs === "INPUT_BET_SIZES") {
      const parsedSizes = [];
      for (const line of lines) {
        if (line.toUpperCase() === "ALL IN" || line.toUpperCase() === "ALL_IN") { parsedSizes.push("ALL_IN"); }
        else if (line.match(/^\d+$/)) { parsedSizes.push(Number(line)); }
      }
      if (!parsedSizes.length) throw new Error("No valid numbers found");
      const s = userSettings[userId];
      if (s.betting_strategy === "D'Alembert" && parsedSizes.length > 1) { await sendMessageWithRetry(ctx, "❌ D'Alembert requires only ONE bet size.", makeMainKeyboard(true)); return; }
      userSettings[userId].bet_sizes = parsedSizes; userSettings[userId].dalembert_units = 1; userSettings[userId].martin_index = 0; userSettings[userId].custom_index = 0;
      const displaySizes = parsedSizes.map(s => s === "ALL_IN" ? "ALL IN" : s).join(' -> ');
      await sendMessageWithRetry(ctx, `✅ Bet Sequence saved:\n${displaySizes}`, makeMainKeyboard(true)); delete userState[userId];
    } else if (cs === "INPUT_BS_PATTERN") {
      const p = text.toUpperCase();
      if (p && p.split('').every(c => c === 'B' || c === 'S')) { userSettings[userId].pattern = p; userSettings[userId].pattern_index = 0; await sendMessageWithRetry(ctx, `✅ Pattern saved:\n${p}`, makeMainKeyboard(true)); delete userState[userId]; }
      else { await sendMessageWithRetry(ctx, "❌ Invalid pattern. Use only 'B' and 'S'.", makeMainKeyboard(true)); }
    } else if (cs === "INPUT_PROFIT_TARGET") {
      const t = parseFloat(lines.length >= 2 ? lines[1] : text);
      if (isNaN(t) || t <= 0) throw new Error("Invalid amount");
      userSettings[userId].target_profit = t; await sendMessageWithRetry(ctx, `✅ Profit Target set to: ${t} MMK`, makeMainKeyboard(true)); delete userState[userId];
    } else if (cs === "INPUT_STOP_LIMIT") {
      const sl = parseFloat(lines.length >= 2 ? lines[1] : text);
      if (isNaN(sl) || sl <= 0) throw new Error("Invalid amount");
      userSettings[userId].stop_loss = sl; await sendMessageWithRetry(ctx, `✅ Stop Loss set to: ${sl} MMK`, makeMainKeyboard(true)); delete userState[userId];
    }
  } catch (error) { await sendMessageWithRetry(ctx, `❌ Error: ${error.message}`, makeMainKeyboard(true)); }
}

async function showUserStats(ctx, userId) {
  const session = userSessions[userId];
  const userInfo = userGameInfo[userId];
  if (!userInfo) { await sendMessageWithRetry(ctx, "❌ Failed to retrieve user info.", makeMainKeyboard(true)); return; }
  const s = userSettings[userId] || {};
  const betSizes = s.bet_sizes || [];
  const strategy = s.strategy || "KENNO_V2";
  const bettingStrategy = s.betting_strategy || "Martingale";
  const virtualMode = s.virtual_mode || false;

  let balance, totalProfit, betOrder;
  if (virtualMode) { balance = userStats[userId]?.virtual_balance || VIRTUAL_BALANCE; totalProfit = balance - VIRTUAL_BALANCE; }
  else { balance = await getBalance(session, userId); totalProfit = userStats[userId]?.profit || 0; }
  let pi = totalProfit > 0 ? "+" : (totalProfit < 0 ? "-" : "");

  if (strategy === "KENNO") {
    const kr = loadKENNOResults();
    if (kr && kr.length >= KENNO_REQUIRED) {
      const kenno = kr[10];
      if (kenno && kenno.number) {
        const num = parseInt(kenno.number) % 10;
        betOrder = `KENNO: [(${num >= 5 ? 'BIG' : 'SMALL'})`;
      } else { betOrder = `KENNO: Data Error`; }
    } else { betOrder = `KENNO: ${kr.length}/${KENNO_REQUIRED} (Collecting...)`; }
  } else if (strategy === "KENNO_V2") {
    const kr = loadKENNOResults();
    if (kr && kr.length > 0) {
      const latest = kr[0];
      const num = parseInt(latest.number) % 10;
      betOrder = `KENNO V2: Copy Latest = ${num >= 5 ? 'BIG' : 'SMALL'} (${num})`;
    } else { betOrder = `KENNO V2: Waiting for first result...`; }
  } else if (strategy === "KENNO_MAX") {
    const kr = loadKENNOResults();
    const maxHits = s.kenno_max_hits || 0;
    const currentHits = userKennoMaxHits[userId] || 0;
    const consecLosses = userKennoMaxConsecLosses[userId] || 0;
    betOrder = `KENNO MAX\nHits: ${currentHits}/${maxHits === 0 ? '∞' : maxHits} | Losses: ${consecLosses}/4`;
  } else if (strategy === "AI_PREDICTION") {
    const rc = userAIRoundCount[userId] || 0;
    betOrder = rc <= 10 ? `AI: Learning (${rc}/10)` : "AI: Active Analysis";
  } else if (strategy === "TREND_FOLLOW") betOrder = "Trend Follow";
  else if (strategy === "ALTERNATE") betOrder = "Alternate B/S";
  else if (strategy === "BS_ORDER") betOrder = `Pattern: ${s.pattern || "Default"}`;
  else betOrder = "AI (Default)";

  const modeText = virtualMode ? "Demo" : "Real";
  const betSizesDisplay = betSizes.map(b => b === "ALL_IN" ? "ALL IN" : b).join(', ');
  const infoText =
    `📊 ACCOUNT OVERVIEW\n` +
    `━━━━━━━━━━━━━━━\n` +
    `User ID: ${userInfo.user_id}\n` +
    `Balance: ${balance !== null ? balance.toFixed(2) : 'N/A'} MMK\n` +
    `Profit: ${pi}${totalProfit.toFixed(2)} MMK\n\n` +
    `⚙️ CONFIGURATION\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Strategy: ${strategy}\n` +
    `Plan: ${bettingStrategy}\n` +
    `Mode: ${modeText}\n` +
    `Bets: ${betSizesDisplay || 'Not Set'}\n\n` +
    `🛡️ RISK MANAGEMENT\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Target: ${s.target_profit || 0} MMK\n` +
    `Stop Loss: ${s.stop_loss || 0} MMK\n` +
    `Entry Layer: ${s.layer_limit || 1}\n` +
    `Skip Loss: ${s.sl_layer || 'Off'}\n\n` +
    `Status: ${s.running ? 'RUNNING' : 'STOPPED'}`;

  await sendMessageWithRetry(ctx, infoText, makeMainKeyboard(true));
}

function main() {
  loadAllowedUsers();

  initKENNOResults().then(success => {
    if (success) logging.info('KENNO initialized');
    else logging.error('KENNO init failed');
  });

  const bot = new Telegraf(BOT_TOKEN);
  bot.start(cmdStartHandler);
  bot.command('allow', cmdAllowHandler);
  bot.command('remove', cmdRemoveHandler);
  bot.command('show', cmdShowHandler);
  bot.on('callback_query', callbackQueryHandler);
  bot.on('text', textMessageHandler);

  winLoseChecker(bot).catch(error => { logging.error(`Checker failed: ${error.message}`); });
  bot.launch().then(() => { logging.info('Bot started'); }).catch(error => { logging.error(`Bot failed: ${error.message}`); });

  process.on('uncaughtException', (error) => { logging.error(`Exception: ${error.message}`); });
  process.on('unhandledRejection', (reason, promise) => { logging.error(`Rejection: ${reason}`); });
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

if (require.main === module) { main(); }
