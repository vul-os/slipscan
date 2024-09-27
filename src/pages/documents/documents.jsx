import React, { useEffect, useState, useContext } from 'react';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion } from "@/components/ui/accordion";
import { FilePlus, ArrowUp, ArrowDown } from 'lucide-react';
import FileUploadModal from './file-upload';
import { toast } from "@/components/ui/use-toast";
import DocumentGroup from './document-group';

const DocumentList = () => {
  const [documentGroups, setDocumentGroups] = useState([]);
  const [sortBy, setSortBy] = useState('upload_date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchDocumentGroups();
    }
  }, [user, sortBy, sortOrder]);

  const fetchDocumentGroups = async () => {
    let query = supabase
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
      .eq('user_id', user.id);

    switch (sortBy) {
      case 'name':
        query = query.order('name', { ascending: sortOrder === 'asc' });
        break;
      case 'upload_date':
        query = query.order('created_at', { ascending: sortOrder === 'asc' });
        break;
      case 'slip_date':
        query = query.order('document_timestamp', { ascending: sortOrder === 'asc', nullsFirst: sortOrder === 'asc' });
        break;
      default:
        query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
     
    if (error) {
      console.error('Error fetching document groups:', error);
      toast({
        title: "Error",
        description: "Failed to fetch documents. Please try again.",
        variant: "destructive",
      });
    } else {
      const groupsWithProcessedData = await Promise.all(data.map(async (group) => {
        const filesWithSignedUrls = await Promise.all(group.document_files.map(async (file) => {
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('snaps')
            .createSignedUrl(file.file_path, 3600);

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
  
      // Refresh the document groups to reflect any changes
      fetchDocumentGroups();
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
          <span>My Slips</span>
          <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="upload_date">Upload Date</SelectItem>
                <SelectItem value="slip_date">Slip Date</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              className="w-[50px]"
            >
              {sortOrder === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            </Button>
            <Button onClick={() => setIsUploadModalOpen(true)}>
              <FilePlus className="mr-2 h-4 w-4" /> 
              Add New Slips
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Accordion type="single" collapsible className="w-full">
          {documentGroups.map((group) => (
            <DocumentGroup
              key={group.id}
              group={group}
              onDeleteFile={(file) => handleDeleteFile(file, group.id)}
              onDeleteGroup={() => handleDeleteGroup(group.id)}
              onProcessImages={() => handleProcessImages(group.id)}
            />
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