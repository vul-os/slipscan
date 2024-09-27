import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, Eye, Folder, ScanEye, ChevronRight } from 'lucide-react';
import FilePreview from './file-preview';

const DocumentGroup = ({ group, onDeleteFile, onDeleteGroup, onProcessImages }) => {
  const handleOpen = (file) => {
    if (file.signedUrl) {
      window.open(file.signedUrl, '_blank');
    } else {
      console.error('No signed URL available for this file');
      toast({
        title: "Error",
        description: "Failed to open the document. Please try again.",
        variant: "destructive",
      });
    }
  };

  const doc_timestamp = (group) => group?.document_timestamp ? new Date(group?.document_timestamp).toLocaleDateString() : "No Date"

  return (
    <AccordionItem value={group.id} className="px-6">
      <AccordionTrigger className="py-4">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center">
            <Folder className="mr-2 h-4 w-4" />
            <span>{group.name || `Group ${group.id}`}</span>
          </div>
          <span className="text-sm text-gray-500 mr-4">
            {doc_timestamp(group)}
          </span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="pt-4 pb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {group.document_files.map((file) => (
            <div key={file.id} className="flex flex-col max-w-[200px]">
              <div className="w-full aspect-square">
                <FilePreview file={file} signedUrl={file.signedUrl} />
              </div>
              <div className="mt-2">
                <h3 className="font-semibold text-sm truncate">{file.file_name}</h3>
                <p className="text-xs text-gray-500">
                  {doc_timestamp(group)}
                </p>
              </div>
              <div className="flex justify-end mt-2">
                <Button variant="ghost" size="sm" onClick={() => handleOpen(file)}><Eye className="h-4 w-4" /></Button>
                <Button variant="ghost" size="sm" onClick={() => onDeleteFile(file)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </div>
        
        {/* Document Group Details */}
        <div className="mt-6 bg-gradient-to-r from-gray-800 to-gray-700 text-white p-6 rounded-lg shadow-lg">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-2xl font-bold">{group.merchants?.name || 'Unknown Merchant'}</h3>
            <p className="text-sm bg-gray-600 px-3 py-1 rounded-full">
              {doc_timestamp(group)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-300">Cashier Name</p>
              <p className="font-semibold">{group.cashier_name?.toUpperCase() || 'N/A'}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-300">Subtotal</p>
              <p className="font-semibold">R{group.subtotal?.toFixed(2) || '0.00'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-300">Tax</p>
              <p className="font-semibold">R{group.tax_amount?.toFixed(2) || '0.00'}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-300">Total</p>
              <p className="text-xl font-bold">R{group.total_amount?.toFixed(2) || '0.00'}</p>
            </div>
          </div>
        </div>
        {/* Items section with data grid */}
        <div className="mt-6">
          <h3 className="text-lg font-semibold mb-2">Items</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Tax Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.extracted_items.slice(0, 5).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.description}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>R{item.price?.toFixed(2) || '0.00'}</TableCell>
                  <TableCell>R{item.tax_amount?.toFixed(2) || '0.00'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {group.extracted_items.length > 5 && (
            <div className="mt-2 text-right">
              <Link to={`/items/${group.id}`}>
                <Button variant="link">
                  Show More <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-4 space-x-2">
          <Button
            variant="default"
            onClick={onProcessImages}
            className="bg-blue-500 hover:bg-blue-600 text-white"
          >
            <ScanEye className="h-4 w-4 mr-2" /> Process Images
          </Button>
          <Button
            variant="ghost"
            onClick={onDeleteGroup}
          >
            <Trash2 className="h-4 w-4 mr-2" /> Delete Group
          </Button>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
};

export default DocumentGroup;