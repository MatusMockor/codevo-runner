/** Fixed descriptor-relative program: no client executable source or shell interpolation. */
export const SURFACE_FILES_HELPER = String.raw`
import os, sys, json, stat, hashlib, secrets
fds=[]
temporary=None
parent=None
try:
 r=json.load(sys.stdin)
 root=os.open(r['cwd'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(root)
 info=os.fstat(root)
 if (info.st_dev,info.st_ino)!=(r['identity']['dev'],r['identity']['ino']): raise ValueError()
 parts=r['path'].split('/') if r['path'] else []
 parent=root
 for part in (parts if r['operation']=='tree' else parts[:-1]):
  parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent); fds.append(parent)
 if r['operation']=='tree':
  names=[]; truncated=False
  with os.scandir(parent) as iterator:
   for entry in iterator:
    if entry.name.lower()=='.git': continue
    if len(names)>=10000: truncated=True; break
    try:
     entry.name.encode('utf-8',errors='strict')
     if any(ord(c)<32 for c in entry.name) or '\\' in entry.name: truncated=True; continue
     kind='symlink' if entry.is_symlink() else ('directory' if entry.is_dir(follow_symlinks=False) else 'file')
     if kind=='file' and not entry.is_file(follow_symlinks=False): continue
     names.append(dict(name=entry.name,path=(r['path']+'/' if r['path'] else '')+entry.name,kind=kind))
    except (UnicodeError,OSError): truncated=True
  names.sort(key=lambda e:(e['kind']!='directory',e['name']))
  page=names[r['offset']:r['offset']+200]
  out=dict(entries=page,nextOffset=r['offset']+len(page) if r['offset']+len(page)<len(names) else None,truncated=truncated)
 else:
  leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent); fds.append(leaf)
  before=os.fstat(leaf)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: raise ValueError()
  data=bytearray()
  if before.st_size<=65536:
   while len(data)<=65536:
    chunk=os.read(leaf,65537-len(data))
    if not chunk: break
    data.extend(chunk)
  after=os.fstat(leaf)
  stamp=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_nlink)
  if stamp(before)!=stamp(after): raise ValueError()
  reason='large' if before.st_size>65536 or len(data)>65536 else None
  text=''
  if reason is None:
   try:
    text=data.decode('utf-8',errors='strict')
    if '\x00' in text: reason='binary'; text=''
   except UnicodeError: reason='binary'
  version=hashlib.sha256(data).hexdigest() if reason is None else None
  if r['operation']=='write':
   if reason is not None or version!=r['expectedVersion']: raise ValueError()
   payload=r['text'].encode('utf-8',errors='strict')
   if len(payload)>65536 or b'\x00' in payload: raise ValueError()
   temporary='.codevo-save-'+secrets.token_hex(16)
   new=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,before.st_mode&0o777,dir_fd=parent); fds.append(new)
   os.fchmod(new,before.st_mode&0o777)
   view=memoryview(payload)
   while view: view=view[os.write(new,view):]
   os.fsync(new)
   # Rewalk the exact visible authority immediately before replacing the original.
   current=os.open(r['cwd'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(current)
   ci=os.fstat(current)
   if (ci.st_dev,ci.st_ino)!=(info.st_dev,info.st_ino): raise ValueError()
   for part in parts[:-1]:
    current=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current); fds.append(current)
   pi=os.fstat(parent); ci=os.fstat(current)
   if (ci.st_dev,ci.st_ino)!=(pi.st_dev,pi.st_ino): raise ValueError()
   if stamp(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False))!=stamp(before): raise ValueError()
   os.replace(temporary,parts[-1],src_dir_fd=parent,dst_dir_fd=parent); temporary=None
   os.fsync(parent)
   text=r['text']; version=hashlib.sha256(payload).hexdigest()
  out=dict(path=r['path'],text=text,version=version,unavailableReason=reason)
 print(json.dumps(out,ensure_ascii=True))
except FileNotFoundError: print(json.dumps(dict(error='not_found')))
except (ValueError,OSError,KeyError,TypeError,UnicodeError): print(json.dumps(dict(error='conflict')))
finally:
 if temporary is not None:
  try: os.unlink(temporary,dir_fd=parent)
  except OSError: pass
 for fd in reversed(fds): os.close(fd)
`;
