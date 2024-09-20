import React, { useEffect, useState, useContext } from 'react';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Trash2, FilePlus, Eye, Folder } from 'lucide-react';
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
        documents (
          id,
          transaction_number,
          document_timestamp,
          document_files (id, bucket_name, file_path, file_name, content_type)
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
      setDocumentGroups(data);
    }
  };

  const handleOpen = async (document) => {
    if (document.document_files && document.document_files[0]) {
      try {
        const { data, error } = await supabase.storage
          .from('snaps')
          .createSignedUrl(document.document_files[0].file_path, 60);

        if (error) throw error;

        window.open(data.signedUrl, '_blank');
      } catch (error) {
        console.error('Error creating signed URL:', error);
        toast({
          title: "Error",
          description: "Failed to open the document. Please try again.",
          variant: "destructive",
        });
      }
    } else {
      console.error('No file associated with this document');
      toast({
        title: "Error",
        description: "No file associated with this document.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id) => {
    try {
      const { data, error } = await supabase.rpc('delete_document_and_files', { doc_id: id });

      if (error) throw error;

      fetchDocumentGroups();
      toast({
        title: "Success",
        description: "Document deleted successfully.",
      });
    } catch (error) {
      console.error('Error deleting document:', error);
      toast({
        title: "Error",
        description: "Failed to delete the document. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDeleteGroup = async (groupId) => {
    try {
      const { data, error } = await supabase.rpc('delete_document_group_and_associated_data', { group_id: groupId });

      if (error) throw error;

      fetchDocumentGroups();
      toast({
        title: "Success",
        description: "Document group deleted successfully.",
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

  return (
    <Card className="w-full">
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
      <CardContent>
        <Accordion type="single" collapsible className="w-full">
          {documentGroups.map((group) => (
            <AccordionItem value={group.id} key={group.id}>
              <AccordionTrigger>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center">
                    <Folder className="mr-2 h-4 w-4" />
                    <span>{group.name || `Group ${group.id}`}</span>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {group.documents.map((doc) => (
                    <Card key={doc.id} className="flex flex-col">
                      <CardContent className="flex-grow p-4">
                        <FilePreview doc={doc} />
                        <h3 className="font-semibold truncate mt-2">{doc.transaction_number}</h3>
                        <p className="text-sm text-gray-500">
                          {new Date(doc.document_timestamp).toLocaleString()}
                        </p>
                      </CardContent>
                      <div className="flex justify-end p-4 pt-0">
                        <Button variant="ghost" onClick={() => handleOpen(doc)}><Eye className="h-4 w-4" /></Button>
                        <Button variant="ghost" onClick={() => handleDelete(doc.id)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </Card>
                  ))}
                </div>
                <div className="flex justify-end mt-4">
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