import React, { useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { X, Upload } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

const FileUploadModal = ({ isOpen, onClose, onUploadComplete, userId }) => {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleFileChange = (event) => {
    setFiles(Array.from(event.target.files));
  };

  const handleUpload = async () => {
    setUploading(true);
    setProgress(0);

    const sessionFolder = new Date().toISOString().replace(/[-:]/g, '').split('.')[0]; // Format: YYYYMMDDTHHMMSS

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileExt = file.name.split('.').pop();
      const fileName = `${uuidv4()}.${fileExt}`;
      const filePath = `${userId}/${sessionFolder}/${fileName}`;

      // Upload file to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('snaps')
        .upload(filePath, file);

      if (uploadError) {
        console.error('Error uploading file:', uploadError);
        continue;
      }

      // Create document record in the database
      const { data, error: insertError } = await supabase
        .from('documents')
        .insert({
          user_id: userId,
          transaction_number: file.name,
          document_timestamp: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error inserting document:', insertError);
        continue;
      }

      // Create document_files record
      const { error: fileError } = await supabase
        .from('document_files')
        .insert({
          user_id: userId,
          document_id: data.id,
          bucket_name: 'slips',
          file_path: filePath,
          file_name: fileName,
          content_type: file.type,
          file_size: file.size,
        });

      if (fileError) {
        console.error('Error inserting document file:', fileError);
      }

      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setUploading(false);
    onUploadComplete();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Upload Documents</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex items-center gap-4">
            <input
              type="file"
              multiple
              onChange={handleFileChange}
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
              className="flex-1"
            />
            <Button onClick={handleUpload} disabled={uploading || files.length === 0}>
              <Upload className="mr-2 h-4 w-4" />
              Upload
            </Button>
          </div>
          {uploading && (
            <Progress value={progress} className="w-full" />
          )}
          <div className="max-h-[200px] overflow-y-auto">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between py-2">
                <span className="truncate max-w-[200px]">{file.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                  disabled={uploading}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FileUploadModal;