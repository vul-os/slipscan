import React from "react";
import { CheckCircle, Loader2, AlertTriangle } from "lucide-react";

const Completion = ({ paymentDetails, paymentStatus, paymentAmount }) => {
  const getStatusContent = () => {
    switch (paymentStatus) {
      case "completed":
        return (
          <div className="flex flex-col items-center justify-center space-y-4">
            <CheckCircle className="w-16 h-16 text-green-500" />
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-green-100 text-center px-4">
              Payment Completed Successfully! 🎉
            </h1>
            <p className="text-xl sm:text-2xl md:text-3xl font-semibold text-green-200">
              Amount: R {paymentAmount.toFixed(2)}
            </p>
            <p className="text-md sm:text-lg text-green-300">
              Transaction ID: {paymentDetails.payment_code}
            </p>
          </div>
        );
      case "pending":
        return (
          <div className="flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-16 h-16 text-blue-500 animate-spin" />
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-blue-100 text-center px-4">
              Payment Processing...
            </h1>
            <p className="text-md sm:text-lg text-blue-300">
              Please wait while we confirm your payment.
            </p>
          </div>
        );
      default:
        return (
          <div className="flex flex-col items-center justify-center space-y-4">
            <AlertTriangle className="w-16 h-16 text-red-500" />
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-red-100 text-center px-4">
              Payment Failed
            </h1>
            <p className="text-md sm:text-lg text-red-300">
              There was an issue processing your payment. Please try again.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-[16rem] sm:min-h-[20rem] md:min-h-[24rem] lg:min-h-[28rem] flex items-center justify-center my-2 border border-gray-600 bg-gray-800 text-gray-100 rounded-md p-6">
      {getStatusContent()}
    </div>
  );
};

export default Completion;