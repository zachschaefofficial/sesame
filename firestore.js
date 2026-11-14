import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
    getFirestore,
    doc,
    getDoc,
    deleteField,
    setDoc,
    onSnapshot,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

// Reuse the Firebase project configured for the Sesame Chrome extension.
const firebaseConfig = {
    apiKey: "AIzaSyDUvZRb1m1GTJhZtF3cuEjyd1FNf2D484U",
    authDomain: "sesame-a7932.firebaseapp.com",
    projectId: "sesame-a7932",
    storageBucket: "sesame-a7932.firebasestorage.app",
    messagingSenderId: "508716152777",
    appId: "1:508716152777:web:39fbb4d4c4d5c756581a18",
    measurementId: "G-1M9QQF0VF2"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Use the normalized account email as the document ID so the website and
// Chrome extension share the same Firestore user document.
const normalizeUserEmail = (email) => {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) {
        throw new Error("A valid account email is required to access Sesame data.");
    }
    return normalized;
};
const userDocument = (email) => doc(db, "users", normalizeUserEmail(email));

// `coins` is the stored seed balance so existing accounts keep their totals.
// Starter categories. Users can rename, recolor, delete, or add their own.
export const DEFAULT_CATEGORIES = [
    { id: "physical", name: "Physical", color: "#e0795f" },
    { id: "mental", name: "Mental", color: "#6fa8dc" },
    { id: "social", name: "Social", color: "#b58fd9" }
];

// Starter goals: an hour a day in each starter category. Goals are time-only.
export const DEFAULT_GOALS = DEFAULT_CATEGORIES.map((category) => ({
    id: `goal-${category.id}`,
    title: `${category.name} hour`,
    categoryId: category.id,
    minutes: 60,
    period: "daily",
    color: category.color
}));

// Only seed goals for categories the user still has.
function defaultGoalsFor(categories) {
    const ids = new Set((categories || []).map((category) => category.id));
    return DEFAULT_GOALS.filter((goal) => ids.has(goal.categoryId));
}

const defaults = {
    blockedSites: [],
    siteTimeLimits: {},
    siteSeedRates: {},
    productivitySites: [],
    productivitySeedRates: {},
    todoTasks: [],
    taskCategories: DEFAULT_CATEGORIES,
    goals: DEFAULT_GOALS,
    defaultGoalsSeeded: true,
    rewards: [],
    coinPenalties: [],
    sleepModeSites: [],
    sleepSchedules: [],
    coins: 0,
    dailySeedStats: {},
    lastDashboardLoginDate: "",
    enabled: true
};

export const observeAuth = (callback) => onAuthStateChanged(auth, callback);
export const createAccount = (email, password) =>
    createUserWithEmailAndPassword(auth, email, password);
export const signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const signOutUser = () => signOut(auth);

export function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeSeedRate(value, fallback = 1) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0) return fallback;
    return Math.round(rate * 100) / 100;
}

// Every task is a task-bank task: it stays in the list and can be completed
// any number of times. (Older daily and one-time tasks are treated the same.)
export function taskMode() {
    return "bank";
}

// Seeds earned per minute of work. Older tasks stored a flat reward, so spread
// that over the task's usual minutes.
export function taskSeedRate(task) {
    const rate = Number(task?.seedsPerMinute);
    if (task?.seedsPerMinute !== undefined && Number.isFinite(rate) && rate >= 0) return rate;
    const minutes = Number(task?.minutes) || 0;
    const flat = Number(task?.reward) || 0;
    return minutes > 0 ? Math.round(flat / minutes * 1000) / 1000 : 0.1;
}

// How good the activity was, 0-100%. 50% is "as expected" (x1.0); the
// multiplier runs from x0.5 to x1.5.
export function qualityMultiplier(quality) {
    const value = Number(quality);
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    return 0.5 + percent / 100;
}

// Volume = minutes x intensity. Goals are measured in volume per task.
export function taskVolume(task) {
    return Math.round((Number(task?.minutes) || 0) * (Number(task?.intensity) || 0) * 100) / 100;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const cleanColor = (value, fallback = "") => HEX_COLOR.test(String(value || "")) ? String(value).toLowerCase() : fallback;

function cleanTaskFields(fields = {}) {
    const clean = {};
    if (fields.title !== undefined) {
        const title = String(fields.title).trim().slice(0, 120);
        if (!title) throw new Error("A task needs a name.");
        clean.title = title;
    }
    if (fields.description !== undefined) clean.description = String(fields.description).trim().slice(0, 500);
    if (fields.categoryId !== undefined) clean.categoryId = String(fields.categoryId || "");
    if (fields.minutes !== undefined) clean.minutes = Math.max(0, Math.min(1440, Math.round(Number(fields.minutes) || 0)));
    if (fields.intensity !== undefined) clean.intensity = Math.max(1, Math.min(10, Math.round(Number(fields.intensity) || 1)));
    if (fields.seedsPerMinute !== undefined) clean.seedsPerMinute = Math.max(0, Math.min(1000, Math.round((Number(fields.seedsPerMinute) || 0) * 1000) / 1000));
    if (fields.color !== undefined) clean.color = cleanColor(fields.color);
    clean.mode = "bank";
    return clean;
}

function pruneDailyStats(stats) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cut = localDateKey(cutoff);
    return Object.fromEntries(
        Object.entries(stats || {}).filter(([key]) => key >= cut)
    );
}

// Daily harvest log: seeds gained/lost and tasks finished, keyed by local date.
function bumpDailyStats(data, { gained = 0, lost = 0, task = null } = {}) {
    const today = localDateKey();
    const stats = pruneDailyStats(data.dailySeedStats || {});
    const day = {
        gained: Number(stats[today]?.gained) || 0,
        lost: Number(stats[today]?.lost) || 0,
        completedTasks: [...(stats[today]?.completedTasks || [])]
    };
    day.gained += Number(gained) || 0;
    day.lost += Number(lost) || 0;
    if (task) {
        day.completedTasks.push({
            taskId: task.id,
            title: task.title,
            reward: Math.max(0, Number(task.reward) || 0),
            categoryId: task.categoryId || "",
            minutes: Number(task.minutes) || 0,
            intensity: Number(task.intensity) || 0,
            minutesSpent: Number(task.minutesSpent) || 0,
            quality: task.quality === undefined ? 50 : Number(task.quality) || 0,
            at: new Date().toISOString()
        });
    }
    stats[today] = day;
    return stats;
}

export async function ensureUserData(email, legacyAuthUid) {
    const normalizedEmail = normalizeUserEmail(email);
    const ref = userDocument(normalizedEmail);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        let existingData = {};
        // Migrate data from accounts created before Sesame used email document IDs.
        if (legacyAuthUid && legacyAuthUid !== normalizedEmail) {
            const legacySnapshot = await getDoc(doc(db, "users", legacyAuthUid));
            if (legacySnapshot.exists()) existingData = legacySnapshot.data();
        }
        const {
            timeOnWebsite, siteTimeByDay, siteUnlockTimeByDay,
            productivityTimeByDay, productivityByDay,
            ...cleanExistingData
        } = existingData;
        await setDoc(ref, {
            ...defaults,
            ...cleanExistingData,
            email: normalizedEmail,
            uid: normalizedEmail
        });
    } else {
        const data = snapshot.data();
        const missing = Object.fromEntries(
            Object.entries(defaults).filter(([key]) => data[key] === undefined)
        );
        // One-time: give existing accounts the starter hour-a-day goals if they
        // have no goals yet.
        const seedGoals = data.defaultGoalsSeeded === undefined
            && Array.isArray(data.goals) && data.goals.length === 0;
        const identity = {};
        if (data.email !== normalizedEmail) identity.email = normalizedEmail;
        if (data.uid !== normalizedEmail) identity.uid = normalizedEmail;
        await setDoc(ref, {
            ...missing,
            ...(seedGoals ? { goals: defaultGoalsFor(data.taskCategories || DEFAULT_CATEGORIES) } : {}),
            ...identity,
            timeOnWebsite: deleteField(),
            siteTimeByDay: deleteField(),
            siteUnlockTimeByDay: deleteField(),
            productivityTimeByDay: deleteField(),
            productivityByDay: deleteField()
        }, { merge: true });
    }
}

export async function getUserData(email) {
    const snapshot = await getDoc(userDocument(email));
    return snapshot.exists() ? snapshot.data() : null;
}

export function watchUserData(email, onData, onError) {
    return onSnapshot(userDocument(email), (snapshot) => {
        onData(snapshot.exists() ? snapshot.data() : null);
    }, onError);
}

async function changeUserData(email, change) {
    const normalizedEmail = normalizeUserEmail(email);
    const ref = userDocument(normalizedEmail);
    return runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists()
            ? { ...defaults, ...snapshot.data() }
            : { ...defaults };
        const updates = change(current) || {};
        transaction.set(ref, {
            ...updates,
            timeOnWebsite: deleteField(),
            siteTimeByDay: deleteField(),
            siteUnlockTimeByDay: deleteField(),
            productivityTimeByDay: deleteField(),
            productivityByDay: deleteField(),
            email: normalizedEmail,
            uid: normalizedEmail
        }, { merge: true });
        return updates;
    });
}

export async function addBlockedSite(email, domain, limitSeconds, seedRate = 1) {
    const rate = normalizeSeedRate(seedRate, 1);
    await changeUserData(email, (data) => {
        const productivitySeedRates = { ...(data.productivitySeedRates || {}) };
        delete productivitySeedRates[domain];
        return {
            blockedSites: [...new Set([...(data.blockedSites || []), domain])],
            productivitySites: (data.productivitySites || []).filter((site) => site !== domain),
            productivitySeedRates,
            siteTimeLimits: {
                ...(data.siteTimeLimits || {}),
                [domain]: Number.isFinite(limitSeconds) ? limitSeconds : 3600
            },
            siteSeedRates: {
                ...(data.siteSeedRates || {}),
                [domain]: rate
            }
        };
    });
}

export async function removeBlockedSite(email, domain) {
    await changeUserData(email, (data) => {
        const siteTimeLimits = { ...(data.siteTimeLimits || {}) };
        const siteSeedRates = { ...(data.siteSeedRates || {}) };
        delete siteTimeLimits[domain];
        delete siteSeedRates[domain];
        return {
            blockedSites: (data.blockedSites || []).filter((site) => site !== domain),
            siteTimeLimits,
            siteSeedRates
        };
    });
}

export async function setSiteTimeLimit(email, domain, limitSeconds) {
    await changeUserData(email, (data) => ({
        siteTimeLimits: {
            ...(data.siteTimeLimits || {}),
            [domain]: limitSeconds
        }
    }));
}

export async function setSiteSeedRate(email, domain, seedRate) {
    const rate = normalizeSeedRate(seedRate, 1);
    await changeUserData(email, (data) => ({
        siteSeedRates: {
            ...(data.siteSeedRates || {}),
            [domain]: rate
        }
    }));
}

export async function addProductiveSite(email, domain, seedRate = 1) {
    const rate = normalizeSeedRate(seedRate, 1);
    await changeUserData(email, (data) => {
        if ((data.blockedSites || []).includes(domain)
            || (data.sleepModeSites || []).includes(domain)
            || (data.sleepSchedules || []).some((schedule) => schedule.domain === domain)) {
            throw new Error("A blocked or sleep-mode site cannot also earn productivity seeds.");
        }
        return {
            productivitySites: [...new Set([...(data.productivitySites || []), domain])],
            productivitySeedRates: {
                ...(data.productivitySeedRates || {}),
                [domain]: rate
            }
        };
    });
}

export async function setProductivitySeedRate(email, domain, seedRate) {
    const rate = normalizeSeedRate(seedRate, 1);
    await changeUserData(email, (data) => ({
        productivitySeedRates: {
            ...(data.productivitySeedRates || {}),
            [domain]: rate
        }
    }));
}

export async function removeProductiveSite(email, domain) {
    await changeUserData(email, (data) => {
        const productivitySeedRates = { ...(data.productivitySeedRates || {}) };
        delete productivitySeedRates[domain];
        return {
            productivitySites: (data.productivitySites || []).filter((site) => site !== domain),
            productivitySeedRates
        };
    });
}

export async function addTodoTask(email, fields) {
    const clean = cleanTaskFields({
        description: "", categoryId: "", minutes: 10, intensity: 5,
        seedsPerMinute: 0.1, color: "", mode: "bank", ...fields
    });
    const task = {
        id: crypto.randomUUID(),
        ...clean,
        recurring: clean.mode === "daily",
        completed: false,
        createdAt: new Date().toISOString()
    };
    await changeUserData(email, (data) => ({ todoTasks: [...(data.todoTasks || []), task] }));
    return task;
}

export async function updateTodoTask(email, taskId, fields) {
    const clean = cleanTaskFields(fields);
    if (clean.mode) clean.recurring = clean.mode === "daily";
    await changeUserData(email, (data) => ({
        todoTasks: (data.todoTasks || []).map((task) => task.id === taskId ? { ...task, ...clean } : task)
    }));
}

// Seeds = base seeds/min x minutes spent x quality multiplier (0.5x-1.5x).
export async function completeTodoTask(email, taskId, { quality = 50, minutesSpent = 0 } = {}) {
    return changeUserData(email, (data) => {
        const tasks = data.todoTasks || [];
        const task = tasks.find((item) => item.id === taskId);
        if (!task) return {};
        const spent = Math.max(0, Math.min(1440, Math.floor(Number(minutesSpent) || 0)));
        const score = Math.max(0, Math.min(100, Math.round(Number.isFinite(Number(quality)) ? Number(quality) : 50)));
        const reward = Math.round(taskSeedRate(task) * spent * qualityMultiplier(score) * 100) / 100;
        const coins = (Number(data.coins) || 0) + reward;
        const completed = { ...task, reward, quality: score, minutesSpent: spent };
        const dailySeedStats = bumpDailyStats(data, { gained: reward, task: completed });
        // Every task is a task-bank task, so it stays in the list for next time.
        return { coins, dailySeedStats };
    });
}

export async function removeTodoTask(email, taskId) {
    await changeUserData(email, (data) => ({
        todoTasks: (data.todoTasks || []).filter((task) => task.id !== taskId)
    }));
}

// Real-life rewards, paid from the stored seed balance (`coins`).
export async function addCoinReward(email, title, description, cost) {
    const reward = { id: crypto.randomUUID(), title: title.trim(), description: description.trim(), cost, createdAt: new Date().toISOString() };
    await changeUserData(email, (data) => ({ rewards: [...(data.rewards || []), reward] }));
    return reward;
}

export async function removeCoinReward(email, rewardId) {
    await changeUserData(email, (data) => ({ rewards: (data.rewards || []).filter((item) => item.id !== rewardId) }));
}

export async function redeemCoinReward(email, rewardId) {
    return changeUserData(email, (data) => {
        const reward = (data.rewards || []).find((item) => item.id === rewardId);
        const coins = Number(data.coins) || 0;
        if (!reward) throw new Error("This reward is no longer available.");
        const cost = Number(reward.cost);
        if (coins < cost) throw new Error("You need more seeds to redeem this reward.");
        return {
            coins: coins - cost,
            dailySeedStats: bumpDailyStats(data, { lost: cost })
        };
    });
}

// Voluntary mistakes the user can apply whenever they choose.
export async function addCoinPenalty(email, title, description, amount) {
    const penalty = { id: crypto.randomUUID(), title: title.trim(), description: description.trim(), amount, createdAt: new Date().toISOString() };
    await changeUserData(email, (data) => ({ coinPenalties: [...(data.coinPenalties || []), penalty] }));
    return penalty;
}

export async function removeCoinPenalty(email, penaltyId) {
    await changeUserData(email, (data) => ({ coinPenalties: (data.coinPenalties || []).filter((item) => item.id !== penaltyId) }));
}

export async function redeemCoinPenalty(email, penaltyId) {
    return changeUserData(email, (data) => {
        const penalty = (data.coinPenalties || []).find((item) => item.id === penaltyId);
        if (!penalty) throw new Error("This penalty is no longer available.");
        const amount = Math.max(0, Number(penalty.amount) || 0);
        return {
            coins: (Number(data.coins) || 0) - amount,
            dailySeedStats: bumpDailyStats(data, { lost: amount })
        };
    });
}

export async function addSleepModeSite(email, domain) {
    await changeUserData(email, (data) => {
        const productivitySeedRates = { ...(data.productivitySeedRates || {}) };
        delete productivitySeedRates[domain];
        return {
            sleepModeSites: [...new Set([...(data.sleepModeSites || []), domain])],
            productivitySites: (data.productivitySites || []).filter((site) => site !== domain),
            productivitySeedRates
        };
    });
}

export async function removeSleepModeSite(email, domain) {
    await changeUserData(email, (data) => ({
        sleepModeSites: (data.sleepModeSites || []).filter((site) => site !== domain)
    }));
}

export async function addSleepSchedule(email, schedule) {
    await changeUserData(email, (data) => {
        const productivitySeedRates = { ...(data.productivitySeedRates || {}) };
        delete productivitySeedRates[schedule.domain];
        return {
            sleepSchedules: [...(data.sleepSchedules || []), schedule],
            productivitySites: (data.productivitySites || []).filter((site) => site !== schedule.domain),
            productivitySeedRates
        };
    });
}

export async function removeSleepSchedule(email, scheduleId) {
    await changeUserData(email, (data) => ({
        sleepSchedules: (data.sleepSchedules || []).filter((item) => item.id !== scheduleId)
    }));
}

// Task categories: user-named and user-colored.
export async function addTaskCategory(email, name, color) {
    const title = String(name || "").trim().slice(0, 40);
    if (!title) throw new Error("Give the category a name.");
    const category = { id: crypto.randomUUID(), name: title, color: cleanColor(color, "#d4a54a") };
    await changeUserData(email, (data) => {
        if ((data.taskCategories || []).some((item) => item.name.toLowerCase() === title.toLowerCase())) {
            throw new Error("You already have a category with that name.");
        }
        return { taskCategories: [...(data.taskCategories || []), category] };
    });
    return category;
}

export async function updateTaskCategory(email, categoryId, { name, color }) {
    const title = String(name || "").trim().slice(0, 40);
    if (!title) throw new Error("Give the category a name.");
    await changeUserData(email, (data) => {
        const categories = data.taskCategories || [];
        if (categories.some((item) => item.id !== categoryId && item.name.toLowerCase() === title.toLowerCase())) {
            throw new Error("You already have a category with that name.");
        }
        return {
            taskCategories: categories.map((item) => item.id === categoryId
                ? { ...item, name: title, color: cleanColor(color, item.color) }
                : item)
        };
    });
}

// Tasks in a deleted category become uncategorized. Goals tied to it block
// the delete so a goal never silently changes meaning.
export async function removeTaskCategory(email, categoryId) {
    await changeUserData(email, (data) => {
        if ((data.goals || []).some((goal) => goal.categoryId === categoryId)) {
            throw new Error("A goal uses this category. Remove or change that goal first.");
        }
        return {
            taskCategories: (data.taskCategories || []).filter((item) => item.id !== categoryId),
            todoTasks: (data.todoTasks || []).map((task) => task.categoryId === categoryId ? { ...task, categoryId: "" } : task)
        };
    });
}

// Goals are time-only: log `minutes` on tasks (optionally within one
// category) per day or per week.
function cleanGoal(fields = {}) {
    return {
        title: String(fields.title || "").trim().slice(0, 80),
        categoryId: String(fields.categoryId || ""),
        minutes: Math.max(1, Math.min(10080, Math.floor(Number(fields.minutes) || 60))),
        period: fields.period === "weekly" ? "weekly" : "daily",
        color: cleanColor(fields.color, "#d4a54a")
    };
}

export async function addGoal(email, fields) {
    const goal = { id: crypto.randomUUID(), ...cleanGoal(fields), createdAt: new Date().toISOString() };
    await changeUserData(email, (data) => ({ goals: [...(data.goals || []), goal] }));
    return goal;
}

export async function updateGoal(email, goalId, fields) {
    await changeUserData(email, (data) => ({
        goals: (data.goals || []).map((goal) => goal.id === goalId
            ? { ...goal, ...cleanGoal({ ...goal, ...fields }) }
            : goal)
    }));
}

export async function removeGoal(email, goalId) {
    await changeUserData(email, (data) => ({ goals: (data.goals || []).filter((goal) => goal.id !== goalId) }));
}

// Remember the local calendar day of the last dashboard open so the recap
// can show only on the first visit of the day.
export async function recordDashboardLogin(email) {
    const today = localDateKey();
    return changeUserData(email, (data) => {
        if (data.lastDashboardLoginDate === today) return {};
        return { lastDashboardLoginDate: today };
    });
}
