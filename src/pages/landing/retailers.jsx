import React from 'react';
import { Store } from 'lucide-react';

const Retailers = React.forwardRef((props, ref) => {
  const retailers = ['Pick n Pay', 'Spar', 'Makro', 'Woolworths', 'Checkers', 'Shoprite', 'Game', 'Dis-Chem'];

  return (
    <section ref={ref} className="py-16 sm:py-24 bg-white rounded-3xl shadow-lg mb-16 sm:mb-24">
      <div className="container mx-auto px-4 sm:px-8">
        <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Supported Retailers</h2>
        <p className="text-lg sm:text-xl text-center text-gray-600 mb-8 sm:mb-12">
          SlipSnap works with receipts from all major retailers. Here are just a few we support:
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-8">
          {retailers.map((retailer, index) => (
            <div key={index} className="flex items-center justify-center bg-gray-100 rounded-lg p-4">
              <Store className="text-blue-600 mr-2" size={20} />
              <span className="font-semibold text-gray-800 text-sm sm:text-base">{retailer}</span>
            </div>
          ))}
        </div>
        <p className="text-center mt-8 sm:mt-12 text-gray-600">
          Don't see your favorite store? Don't worry! SlipSnap works with virtually any receipt.
        </p>
      </div>
    </section>
  );
});

export default Retailers;