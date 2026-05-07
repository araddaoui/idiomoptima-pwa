/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Superscript from '@tiptap/extension-superscript';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect } from 'react';
import { 
  Bold, 
  Italic, 
  Underline as UnderlineIcon, 
  Superscript as SuperscriptIcon,
  List,
  ListOrdered
} from 'lucide-react';

interface RichTextEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

const MenuBar = ({ editor }: { editor: any }) => {
  if (!editor) return null;

  return (
    <div className="flex flex-wrap gap-1 p-2 border-b border-[#E5E5E5] bg-[#F9F9F9]">
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={!editor.can().chain().focus().toggleBold().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('bold') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Bold"
      >
        <Bold className="w-4 h-4" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={!editor.can().chain().focus().toggleItalic().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('italic') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Italic"
      >
        <Italic className="w-4 h-4" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('underline') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Underline"
      >
        <UnderlineIcon className="w-4 h-4" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('superscript') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Superscript"
      >
        <SuperscriptIcon className="w-4 h-4" />
      </button>
      <div className="w-[1px] h-4 bg-[#E5E5E5] self-center mx-1" />
      <button
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('bulletList') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Bullet List"
      >
        <List className="w-4 h-4" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={`p-1.5 rounded hover:bg-[#E5E5E5] transition-colors ${editor.isActive('orderedList') ? 'bg-[#E5E5E5] text-black' : 'text-[#666]'}`}
        title="Ordered List"
      >
        <ListOrdered className="w-4 h-4" />
      </button>
    </div>
  );
};

export function RichTextEditor({ content, onChange, placeholder, disabled }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Superscript,
      Underline,
      Placeholder.configure({
        placeholder: placeholder || 'Type or paste your text here...',
      }),
    ],
    content: content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editable: !disabled,
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full bg-white">
      <MenuBar editor={editor} />
      <div className="flex-1 overflow-y-auto p-8 font-serif text-xl leading-relaxed focus-within:outline-none min-h-[600px]">
        <EditorContent 
          editor={editor} 
          className="outline-none h-full"
        />
      </div>
    </div>
  );
}
