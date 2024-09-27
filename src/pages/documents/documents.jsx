import React, { useEffect, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, FilePlus, Eye, Folder, ScanEye, ChevronRight } from 'lucide-react';
import FileUploadModal from './file-upload';
import { toast } from "@/components/ui/use-toast";
import FilePreview from './file-preview';

const DocumentList = () => {
  const [documentGroups, setDocumentGroups] = useState([]);
  const [sortBy, setSortBy] = useState('date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchDocumentGroups();
    }
  }, [user, sortBy, sortOrder]);

  const fetchDocumentGroups = async () => {
    const { data, error } = await supabase
      .from('document_groups')
      .select(`
        id,
        name,
        description,
        created_at,
        cashier_name,
        document_timestamp,
        subtotal,
        tax_amount,
        total_amount,
        merchants (id, name),
        document_files (id, bucket_name, file_path, file_name, content_type),
        extracted_items (
          id,
          description,
          quantity,
          price,
          tax_amount,
          user_modified_extracted_items (
            id,
            description,
            quantity,
            price,
            tax_amount
          )
        )
      `)
      .eq('user_id', user.id)
      .order(sortBy === 'name' ? 'name' : 'created_at', { ascending: sortOrder === 'asc' });
     
    if (error) {
      console.error('Error fetching document groups:', error);
      toast({
        title: "Error",
        description: "Failed to fetch documents. Please try again.",
        variant: "destructive",
      });
    } else {
      // Generate signed URLs for each file and process extracted items
      const groupsWithProcessedData = await Promise.all(data.map(async (group) => {
        const filesWithSignedUrls = await Promise.all(group.document_files.map(async (file) => {
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('snaps')
            .createSignedUrl(file.file_path, 3600); // URL valid for 1 hour

          if (signedUrlError) {
            console.error('Error creating signed URL:', signedUrlError);
            return { ...file, signedUrl: null };
          }

          return { ...file, signedUrl: signedUrlData.signedUrl };
        }));

        const processedItems = group.extracted_items.map(item => ({
          ...item,
          ...item.user_modified_extracted_items[0],
          isModified: item.user_modified_extracted_items.length > 0
        }));

        return { ...group, document_files: filesWithSignedUrls, extracted_items: processedItems };
      }));

      setDocumentGroups(groupsWithProcessedData);
    }
  };

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

  const handleDeleteFile = async (file, groupId) => {
    try {
      // Delete the file from storage
      const { error: storageError } = await supabase.storage
        .from('snaps')
        .remove([file.file_path]);

      if (storageError) throw storageError;

      // Delete the file record from the database
      const { error: dbError } = await supabase
        .from('document_files')
        .delete()
        .eq('id', file.id);

      if (dbError) throw dbError;

      // Update the state
      setDocumentGroups(prevGroups =>
        prevGroups.map(group =>
          group.id === groupId
            ? { ...group, document_files: group.document_files.filter(f => f.id !== file.id) }
            : group
        )
      );

      toast({
        title: "Success",
        description: "File deleted successfully.",
      });
    } catch (error) {
      console.error('Error deleting file:', error);
      toast({
        title: "Error",
        description: "Failed to delete the file. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDeleteGroup = async (groupId) => {
    try {
      // Fetch all files in the group
      const { data: groupFiles, error: fetchError } = await supabase
        .from('document_files')
        .select('file_path')
        .eq('document_group_id', groupId);

      if (fetchError) throw fetchError;

      // Delete all files from storage
      if (groupFiles && groupFiles.length > 0) {
        const filePaths = groupFiles.map(file => file.file_path);
        const { error: storageError } = await supabase.storage
          .from('snaps')
          .remove(filePaths);

        if (storageError) throw storageError;
      }

      // Delete the group and associated data from the database
      const { error: deleteError } = await supabase.rpc('delete_document_group_and_associated_data', { group_id: groupId });

      if (deleteError) throw deleteError;

      // Update the state
      setDocumentGroups(prevGroups => prevGroups.filter(group => group.id !== groupId));

      toast({
        title: "Success",
        description: "Document group and associated files deleted successfully.",
      });
    } catch (error) {
      console.error('Error deleting document group:', error);
      toast({
        title: "Error",
        description: "Failed to delete the document group. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleProcessImages = async (groupId) => {
    try {
      const { data, error } = await supabase.functions.invoke('scan-images', {
        body: { documentGroupId: groupId },
      });
  
      if (error) throw error;

      toast({
        title: "Success",
        description: "Documents processed successfully.",
      });
  
    } catch (error) {
      console.error('Error processing images:', error);
      toast({
        title: "Error",
        description: `Failed to process images: ${error.message}`,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="w-full max-w-[1200px] mx-auto">
      <CardHeader>
        <CardTitle className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-2 sm:space-y-0">
          <span>My Documents</span>
          <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="date">Date</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort order" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setIsUploadModalOpen(true)}>
              <FilePlus className="mr-2 h-4 w-4" /> 
              Add New Documents
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Accordion type="single" collapsible className="w-full">
          {documentGroups.map((group) => (
            <AccordionItem value={group.id} key={group.id} className="px-6">
              <AccordionTrigger className="py-4">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center">
                    <Folder className="mr-2 h-4 w-4" />
                    <span>{group.name || `Group ${group.id}`}</span>
                  </div>
                  <span className="text-sm text-gray-500 mr-4">
                    {new Date(group.document_timestamp).toLocaleDateString()}
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
                          {new Date(group.document_timestamp).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex justify-end mt-2">
                        <Button variant="ghost" size="sm" onClick={() => handleOpen(file)}><Eye className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteFile(file, group.id)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Document Group Details */}
                <div className="mt-6 bg-gradient-to-r from-gray-800 to-gray-700 text-white p-6 rounded-lg shadow-lg">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-2xl font-bold">{group.merchants?.name || 'Unknown Merchant'}</h3>
                    <p className="text-sm bg-gray-600 px-3 py-1 rounded-full">
                      {new Date(group.document_timestamp).toLocaleDateString()}
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
                          <TableCell>${item.price?.toFixed(2) || '0.00'}</TableCell>
                          <TableCell>${item.tax_amount?.toFixed(2) || '0.00'}</TableCell>
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
                    onClick={() => handleProcessImages(group.id)}
                    className="bg-blue-500 hover:bg-blue-600 text-white"
                  >
                    <ScanEye className="h-4 w-4 mr-2" /> Process Images
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDeleteGroup(group.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Delete Group
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
      <FileUploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUploadComplete={fetchDocumentGroups}
        userId={user.id}
      />
    </Card>
  );
};

export default DocumentList;