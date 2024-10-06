import React from 'react';

const FAQ = React.forwardRef((props, ref) => {
  const faqItems = [
    { q: "Is SlipSnap really free?", a: "Yes, SlipSnap is 100% free to use. We believe in making financial management accessible to everyone." },
    { q: "How accurate is the receipt scanning?", a: "Our AI-powered scanning is highly accurate. However, we always recommend reviewing the results for any discrepancies." },
    { q: "Can I export my data?", a: "We're actively working on implementing data export functionality. Soon, you'll be able to export your data in various formats for use in other financial tools or for your records. Stay tuned for updates!" },
    { q: "Is my data safe?", a: "We take data security very seriously. Your information is encrypted, and we never store original receipt images. Read more in our security section." }
  ];

  return (
    <section ref={ref} className="mb-16 sm:mb-24">
      <h2 className="text-3xl sm:text-4xl font-bold text-center mb-8 sm:mb-12 text-gray-800">Frequently Asked Questions</h2>
      <div className="space-y-6 sm:space-y-8">
        {faqItems.map((item, index) => (
          <div key={index} className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg sm:text-xl font-semibold mb-2 text-gray-800">{item.q}</h3>
            <p className="text-gray-600">{item.a}</p>
          </div>
        ))}
      </div>
    </section>
  );
});

export default FAQ;