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

const userDocument = (userId) => doc(db, "users", userId);
const defaults = {
    blockedSites: [],
    timeOnWebsite: {},
    siteTimeLimits: {},
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

export async function ensureUserData(userId) {
    const ref = userDocument(userId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        await setDoc(ref, defaults);
    } else {
        const data = snapshot.data();
        const missing = Object.fromEntries(
            Object.entries(defaults).filter(([key]) => data[key] === undefined)
        );
        if (Object.keys(missing).length) {
            await setDoc(ref, missing, { merge: true });
        }
    }
}

export async function getUserData(userId) {
    const snapshot = await getDoc(userDocument(userId));
    return snapshot.exists() ? snapshot.data() : null;
}

export function watchUserData(userId, onData, onError) {
    return onSnapshot(userDocument(userId), (snapshot) => {
        onData(snapshot.exists() ? snapshot.data() : null);
    }, onError);
}

async function changeUserData(userId, change) {
    const ref = userDocument(userId);
    await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists()
            ? { ...defaults, ...snapshot.data() }
            : { ...defaults };
        transaction.set(ref, change(current), { merge: true });
    });
}

export async function addBlockedSite(userId, domain, limitSeconds) {
    await changeUserData(userId, (data) => ({
        blockedSites: [...new Set([...(data.blockedSites || []), domain])],
        siteTimeLimits: {
            ...(data.siteTimeLimits || {}),
            [domain]: Number.isFinite(limitSeconds) ? limitSeconds : 3600
        }
    }));
}

export async function removeBlockedSite(userId, domain) {
    await changeUserData(userId, (data) => ({
        blockedSites: (data.blockedSites || []).filter((site) => site !== domain)
    }));
}

export async function setSiteTimeLimit(userId, domain, limitSeconds) {
    await changeUserData(userId, (data) => ({
        siteTimeLimits: {
            ...(data.siteTimeLimits || {}),
            [domain]: limitSeconds
        }
    }));
}
