import React, { useState } from 'react';
import { supabase } from '../../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { X, Upload, FileIcon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import imageCompression from 'browser-image-compression';

const FileUploadModal = ({ isOpen, onClose, onUploadComplete, userId }) => {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleFileChange = (event) => {
    const newFiles = Array.from(event.target.files);
    setFiles(prevFiles => [...prevFiles, ...newFiles]);
  };

  const removeFile = (index) => {
    setFiles(prevFiles => prevFiles.filter((_, i) => i !== index));
  };

  const compressImage = async (file) => {
    const options = {
      maxSizeMB: 5,
      maxWidthOrHeight: 1920,
      useWebWorker: true,
    };

    try {
      const compressedFile = await imageCompression(file, options);
      return compressedFile;
    } catch (error) {
      console.error("Error compressing image:", error);
      return file;
    }
  };

  const handleUpload = async () => {
    setUploading(true);
    setProgress(0);

    const documentGroupId = uuidv4();
    const sessionFolder = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];

    try {
      // Create a new document group
      const { data: groupData, error: groupError } = await supabase
        .from('document_groups')
        .insert({
          id: documentGroupId,
          user_id: userId,
          name: `${sessionFolder}`,
          transaction_number: files[0].name, // Use the first file's name as the transaction number
          document_timestamp: new Date().toISOString(),
        })
        .select()
        .single();

      if (groupError) throw groupError;

      for (let i = 0; i < files.length; i++) {
        let file = files[i];
        const fileExt = file.name.split('.').pop().toLowerCase();
        const fileNameWithoutExt = file.name.replace(`.${fileExt}`, '');

        if (['jpg', 'jpeg', 'png'].includes(fileExt)) {
          file = await compressImage(file);
        }
        const fileName = `${fileNameWithoutExt}-${uuidv4()}.${fileExt}`;
        const filePath = `${userId}/${sessionFolder}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('snaps')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { error: fileError } = await supabase
          .from('document_files')
          .insert({
            user_id: userId,
            document_group_id: documentGroupId,
            bucket_name: 'snaps',
            file_path: filePath,
            file_name: fileName,
            content_type: file.type,
            file_size: file.size,
          });

        if (fileError) throw fileError;

        setProgress(Math.round(((i + 1) / files.length) * 100));
      }

      onUploadComplete();
      onClose();
    } catch (error) {
      console.error('Error during upload process:', error);
      // Here you might want to add some user-facing error handling
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Upload Documents</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 py-4">
          <div className="flex items-center gap-4">
            <label htmlFor="file-upload" className="cursor-pointer w-full">
              <div className="flex items-center justify-center w-full h-32 px-4 transition bg-white border-2 border-gray-300 border-dashed rounded-md appearance-none hover:border-gray-400 focus:outline-none">
                <span className="flex items-center space-x-2">
                  <Upload className="w-6 h-6 text-gray-600" />
                  <span className="font-medium text-gray-600">
                    Click to upload or drag and drop
                  </span>
                </span>
                <input
                  id="file-upload"
                  name="file-upload"
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={handleFileChange}
                  accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                />
              </div>
            </label>
          </div>
          
          {files.length > 0 && (
            <div className="mt-4">
              <h3 className="text-lg font-semibold mb-2">Selected Files:</h3>
              <div className="max-h-[200px] overflow-y-auto space-y-2 bg-gray-50 p-3 rounded-md">
                {files.map((file, index) => (
                  <div key={index} className="flex items-center justify-between py-2 px-3 bg-white rounded-md shadow-sm">
                    <div className="flex items-center space-x-2 flex-1 min-w-0">
                      <FileIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-gray-700 truncate">
                        {file.name}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile(index)}
                      disabled={uploading}
                      className="text-gray-500 hover:text-gray-700 flex-shrink-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {uploading && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-gray-500">Uploading...</div>
              <Progress value={progress} className="w-full" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline" disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={uploading || files.length === 0}>
            <Upload className="mr-2 h-4 w-4" />
            Upload {files.length} file{files.length !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FileUploadModal;