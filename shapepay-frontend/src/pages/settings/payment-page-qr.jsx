import React, { useState, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { CopyIcon, ExternalLink, Printer, Download } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { toast } from "@/components/ui/use-toast";

const PaymentPageQR = ({ merchant }) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const qrCodeRef = useRef(null);
  const paymentLink = `https://app.shapepay.co.za/pay/${merchant?.handle}`;

  const copyLinkToClipboard = () => {
    navigator.clipboard.writeText(paymentLink)
      .then(() => toast({ title: "Link copied to clipboard", duration: 2000 }))
      .catch(() => toast({ title: "Failed to copy link", variant: "destructive" }));
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>${merchant?.name} - Payment QR Code</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              text-align: center; 
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
            }
            h1 { color: #333; margin-bottom: 20px; }
            p { margin-bottom: 20px; }
            .qr-code { margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>${merchant?.name}</h1>
          <p>${paymentLink}</p>
          <div class="qr-code">${qrCodeRef.current.innerHTML}</div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const handleDownloadPDF = () => {
    const canvas = document.createElement("canvas");
    const svg = qrCodeRef.current.querySelector('svg');
    const svgData = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const imgData = canvas.toDataURL("image/png");
      
      const pdf = new jsPDF();
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();

      // Add merchant name
      pdf.setFontSize(20);
      pdf.text(merchant?.name, pageWidth / 2, 30, { align: 'center' });

      // Add payment link
      pdf.setFontSize(12);
      pdf.text(paymentLink, pageWidth / 2, 50, { align: 'center' });

      // Add QR code
      const qrCodeSize = 100;
      pdf.addImage(imgData, 'PNG', (pageWidth - qrCodeSize) / 2, 70, qrCodeSize, qrCodeSize);

      pdf.save(`${merchant?.name}_payment_qr_code.pdf`);
    };
    img.src = "data:image/svg+xml;base64," + btoa(svgData);
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="text-gray-100">Payment Page QR</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between bg-gray-700 p-2 rounded">
          <span className="text-gray-300 truncate mr-2">{paymentLink}</span>
          <div className="flex space-x-2">
            <Button variant="ghost" size="sm" onClick={copyLinkToClipboard}>
              <CopyIcon className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" as="a" href={paymentLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <div className="flex justify-center cursor-pointer" ref={qrCodeRef}>
              <QRCodeSVG value={paymentLink} size={200} bgColor="#1F2937" fgColor="#F9FAFB" />
            </div>
          </DialogTrigger>
          <DialogContent className="bg-gray-800 text-gray-100">
            <QRCodeSVG value={paymentLink} size={400} bgColor="#1F2937" fgColor="#F9FAFB" />
          </DialogContent>
        </Dialog>
        <div className="flex justify-center space-x-4">
          <Button variant="outline" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
          <Button variant="outline" onClick={handleDownloadPDF}>
            <Download className="h-4 w-4 mr-2" />
            Download PDF
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default PaymentPageQR;