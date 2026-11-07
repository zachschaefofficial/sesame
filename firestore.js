import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
    getFirestore,
    doc,
    getDoc,
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
const defaults = {
    blockedSites: [],
    timeOnWebsite: {},
    siteTimeByDay: {},
    siteTimeLimits: {},
    productivitySites: [],
    productivityTimeByDay: {},
    todoTasks: [],
    sleepModeSites: [],
    sleepSchedules: [],
    siteUnlockTimeByDay: {},
    coins: 0,
    enabled: true
};

export const observeAuth = (callback) => onAuthStateChanged(auth, callback);
export const createAccount = (email, password) =>
    createUserWithEmailAndPassword(auth, email, password);
export const signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const signOutUser = () => signOut(auth);

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
        await setDoc(ref, {
            ...defaults,
            ...existingData,
            email: normalizedEmail,
            uid: normalizedEmail
        });
    } else {
        const data = snapshot.data();
        const missing = Object.fromEntries(
            Object.entries(defaults).filter(([key]) => data[key] === undefined)
        );
        const identity = {};
        if (data.email !== normalizedEmail) identity.email = normalizedEmail;
        if (data.uid !== normalizedEmail) identity.uid = normalizedEmail;
        if (Object.keys(missing).length || Object.keys(identity).length) {
            await setDoc(ref, { ...missing, ...identity }, { merge: true });
        }
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
            email: normalizedEmail,
            uid: normalizedEmail
        }, { merge: true });
        return updates;
    });
}

export async function addBlockedSite(email, domain, limitSeconds) {
    await changeUserData(email, (data) => ({
        blockedSites: [...new Set([...(data.blockedSites || []), domain])],
        productivitySites: (data.productivitySites || []).filter((site) => site !== domain),
        siteTimeLimits: {
            ...(data.siteTimeLimits || {}),
            [domain]: Number.isFinite(limitSeconds) ? limitSeconds : 3600
        }
    }));
}

export async function removeBlockedSite(email, domain) {
    await changeUserData(email, (data) => ({
        blockedSites: (data.blockedSites || []).filter((site) => site !== domain)
    }));
}

export async function setSiteTimeLimit(email, domain, limitSeconds) {
    await changeUserData(email, (data) => ({
        siteTimeLimits: {
            ...(data.siteTimeLimits || {}),
            [domain]: limitSeconds
        }
    }));
}


export async function addProductiveSite(email, domain) {
    await changeUserData(email, (data) => {
        if ((data.blockedSites || []).includes(domain)
            || (data.sleepModeSites || []).includes(domain)
            || (data.sleepSchedules || []).some((schedule) => schedule.domain === domain)) {
            throw new Error("A blocked or sleep-mode site cannot also earn productivity coins.");
        }
        return { productivitySites: [...new Set([...(data.productivitySites || []), domain])] };
    });
}

export async function removeProductiveSite(email, domain) {
    await changeUserData(email, (data) => ({
        productivitySites: (data.productivitySites || []).filter((site) => site !== domain)
    }));
}

export async function addTodoTask(email, title, reward) {
    const task = { id: crypto.randomUUID(), title: title.trim(), reward, completed: false };
    await changeUserData(email, (data) => ({ todoTasks: [...(data.todoTasks || []), task] }));
    return task;
}

export async function completeTodoTask(email, taskId) {
    return changeUserData(email, (data) => {
        const tasks = data.todoTasks || [];
        const task = tasks.find((item) => item.id === taskId);
        if (!task || task.completed) return {};
        return {
            todoTasks: tasks.map((item) => item.id === taskId
                ? { ...item, completed: true, completedAt: new Date().toISOString() }
                : item),
            coins: (Number(data.coins) || 0) + Math.max(0, Number(task.reward) || 0)
        };
    });
}

export async function removeTodoTask(email, taskId) {
    await changeUserData(email, (data) => ({
        todoTasks: (data.todoTasks || []).filter((task) => task.id !== taskId)
    }));
}

export async function addSleepModeSite(email, domain) {
    await changeUserData(email, (data) => ({
        sleepModeSites: [...new Set([...(data.sleepModeSites || []), domain])],
        productivitySites: (data.productivitySites || []).filter((site) => site !== domain)
    }));
}

export async function removeSleepModeSite(email, domain) {
    await changeUserData(email, (data) => ({
        sleepModeSites: (data.sleepModeSites || []).filter((site) => site !== domain)
    }));
}

export async function addSleepSchedule(email, schedule) {
    await changeUserData(email, (data) => ({
        sleepSchedules: [...(data.sleepSchedules || []), schedule],
        productivitySites: (data.productivitySites || []).filter((site) => site !== schedule.domain)
    }));
}

export async function removeSleepSchedule(email, scheduleId) {
    await changeUserData(email, (data) => ({
        sleepSchedules: (data.sleepSchedules || []).filter((item) => item.id !== scheduleId)
    }));
}
