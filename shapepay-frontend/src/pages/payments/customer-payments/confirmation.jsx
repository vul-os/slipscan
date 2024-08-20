import React from "react";
import { Copy } from "lucide-react";
import PayshapLogo from "./payshap-logo";

const shapNumber = "+2779048662@FNB"

const PaymentConfoirmationStep = ({ paymentDetails }) => {
    const handleCopyCode = () => {
        navigator.clipboard.writeText(paymentDetails?.payment_code);
        alert("Transaction code copied to clipboard!");
    };
    
    const handleCopyNumber = () => {
        navigator.clipboard.writeText(`${shapNumber}`);
        alert("Phone number copied to clipboard!");
    };

  return (
    <div className="flex flex-col items-center justify-center w-full">
      <h2 className="text-xl sm:text-2xl font-semibold text-center text-gray-100 mb-4 sm:mb-6">
        Payshap Payment Details
      </h2>
      <div className="w-full space-y-4 sm:space-y-6">
        <div className="flex flex-col gap-2 w-full">
          <label htmlFor="phone-number" className="text-sm font-medium text-gray-300">
            ShapID
          </label>
          <div className="flex items-center bg-gray-700 rounded-md">
            <div className="flex items-center bg-gray-800 border-r border-gray-600 rounded-l-md px-2 sm:px-3 py-2">
              <PayshapLogo className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <span id="phone-number" className="text-white font-bold text-sm sm:text-base px-2 sm:px-4 py-2 flex-grow overflow-x-auto whitespace-nowrap">
              {shapNumber}
            </span>
            <button
              onClick={handleCopyNumber}
              className="text-gray-300 hover:text-gray-100 px-2 sm:px-4 py-2 border-l border-gray-600"
              aria-label="Copy phone number"
            >
              <Copy className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <label htmlFor="payment-code" className="text-sm font-medium text-gray-300">
            Reference
          </label>
          <div className="flex items-center bg-gray-700 rounded-md">
            <span id="payment-code" className="text-white font-bold text-sm sm:text-base px-2 sm:px-4 py-2 flex-grow overflow-x-auto whitespace-nowrap">
              {paymentDetails?.payment_code}
            </span>
            <button
              onClick={handleCopyCode}
              className="text-gray-300 hover:text-gray-100 px-2 sm:px-4 py-2 border-l border-gray-600"
              aria-label="Copy payment code"
            >
              <Copy className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentConfoirmationStep;