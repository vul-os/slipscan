// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "***REMOVED***",
  authDomain: "slipscan-b6484.firebaseapp.com",
  projectId: "slipscan-b6484",
  storageBucket: "slipscan-b6484.appspot.com",
  messagingSenderId: "791430940012",
  appId: "1:791430940012:web:e56ec21527ec4a89a89f49",
  measurementId: "G-N3VXB1GWPY"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);