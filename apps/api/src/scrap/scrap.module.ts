import { Module } from '@nestjs/common';
import { ScrapController } from './scrap.controller';
import { ScrapService } from './scrap.service';
import { SequenceService } from '../common/sequence.service';

@Module({
  controllers: [ScrapController],
  providers: [ScrapService, SequenceService],
})
export class ScrapModule {}
