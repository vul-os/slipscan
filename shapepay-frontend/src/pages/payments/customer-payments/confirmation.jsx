import React from "react";
import { Copy, Phone } from "lucide-react";
import SouthAfricanFlag from "./rsa-icon";

const ConfirmationStep = ({ paymentCode, phoneNumber, handleCopyPaymentCode }) => {
    const handleCopyCode = () => {
        navigator.clipboard.writeText(paymentCode);
        alert("Payment code copied to clipboard!");
      };
    
      const handleCopyNumber = () => {
        navigator.clipboard.writeText(`+27${phoneNumber}`);
        alert("Payment code copied to clipboard!");
      };
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-8 w-full max-w-md mx-auto">
      <h2 className="text-2xl font-semibold text-center text-gray-100 mb-4">
        Payment Confirmation
      </h2>
      <div className="w-full space-y-6">
        <div className="flex flex-col gap-2 w-full">
          <label htmlFor="phone-number" className="text-sm font-medium text-gray-300">
            Phone Number
          </label>
          <div className="flex items-center bg-gray-700 rounded-md">
            <div className="flex items-center bg-gray-800 border-r border-gray-600 rounded-l-md px-3 py-2">
              <SouthAfricanFlag />
              <span className="text-gray-300 font-medium ml-2">+27</span>
            </div>
            <span id="phone-number" className="text-white font-bold px-4 py-2 flex-grow">
              {phoneNumber}
            </span>
            <button
              onClick={handleCopyNumber}
              className="text-gray-300 hover:text-gray-100 px-4 py-2 border-l border-gray-600"
              aria-label="Copy phone number"
            >
              <Copy className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <label htmlFor="payment-code" className="text-sm font-medium text-gray-300">
            Payment Code
          </label>
          <div className="flex items-center bg-gray-700 rounded-md">
            <span id="payment-code" className="text-white font-bold px-4 py-2 flex-grow">
              {paymentCode}
            </span>
            <button
              onClick={handleCopyCode}
              className="text-gray-300 hover:text-gray-100 px-4 py-2 border-l border-gray-600"
              aria-label="Copy payment code"
            >
              <Copy className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationStep;