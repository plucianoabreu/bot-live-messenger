import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverCatalogPicture } from '../src/components/approved/display-picture-picker';

test('a broken picker asset is removed instead of becoming a duplicate default picture',()=>{
 const input={checked:true,disabled:false};
 const option={hidden:false,querySelector:()=>input};
 const image={
  dataset:{catalogPicture:'missing.png'},
  hidden:false,
  src:'/assets/display-pictures/missing.png',
  closest:()=>option,
 } as unknown as HTMLImageElement;

 assert.equal(recoverCatalogPicture(image,'/assets/display-pictures/default.png'),'hidden-option');
 assert.equal(option.hidden,true);
 assert.equal(input.disabled,false);
 assert.equal(input.checked,true);
 assert.equal(image.src,'/assets/display-pictures/missing.png');
 assert.equal(image.dataset.fallback,undefined);
});

test('a broken unselected picker asset cannot be submitted',()=>{
 const input={checked:false,disabled:false};
 const option={hidden:false,querySelector:()=>input};
 const image={dataset:{catalogPicture:'missing.png'},hidden:false,src:'missing.png',closest:()=>option} as unknown as HTMLImageElement;

 recoverCatalogPicture(image,'default.png');
 assert.equal(input.disabled,true);
 assert.equal(input.checked,false);
});

test('a broken portrait outside the picker falls back once, then hides if the default also fails',()=>{
 const image={
  dataset:{catalogPicture:'missing.png'},
  hidden:false,
  src:'/assets/display-pictures/missing.png',
  closest:()=>null,
 } as unknown as HTMLImageElement;

 assert.equal(recoverCatalogPicture(image,'/assets/display-pictures/default.png'),'fallback');
 assert.equal(image.src,'/assets/display-pictures/default.png');
 assert.equal(image.dataset.fallback,'true');
 assert.equal(recoverCatalogPicture(image,'/assets/display-pictures/default.png'),'hidden-image');
 assert.equal(image.hidden,true);
});
